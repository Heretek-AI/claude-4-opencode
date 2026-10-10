import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { asBoolean, asString, asStringList, isRecord, parseMarkdown } from "./frontmatter.ts"
import type {
  AgentDef,
  CommandDef,
  HookConfig,
  HookHandler,
  HookMatcher,
  Issue,
  LoadedPlugin,
  LspServerDef,
  MarketplaceEntry,
  McpServerDef,
  PluginManifest,
  SkillDef,
  Unsupported,
} from "./types.ts"

export interface LoadOptions {
  root: string
  /** The marketplace entry this plugin was installed from, if any. It can supply or extend the manifest. */
  entry?: MarketplaceEntry
  /** True when the entry's source is the marketplace root. Entry `skills` then replace the default scan. */
  entryIsMarketplaceRoot?: boolean
  /** Used when neither the manifest nor the entry names the plugin. */
  name?: string
}

const COMPONENT_KEYS = ["commands", "agents", "skills", "hooks", "outputStyles", "themes"] as const

/**
 * Reads a Claude Code plugin directory into a normalized description.
 * Follows the standard layout and manifest rules in the plugin manifest reference.
 */
export function loadPlugin(options: LoadOptions): LoadedPlugin {
  const issues: Issue[] = []
  const root = path.resolve(options.root)
  const own = readManifest(root, issues)
  const entry = options.entry
  const name = asString(own?.name) ?? asString(entry?.name) ?? options.name ?? path.basename(root)

  // With no plugin.json the entry is the manifest. With one, a strict entry may add
  // components, and a non-strict entry that declares any is a conflict.
  const conflict =
    own !== undefined && entry?.strict === false && COMPONENT_KEYS.some((key) => entry[key] !== undefined)
  if (conflict) issues.push({ level: "error", message: `Plugin ${name} has conflicting manifests` })
  const extra: PluginManifest | undefined = conflict ? undefined : entry
  const manifest: PluginManifest = own ?? entry ?? {}
  // Only component fields are appended to an existing manifest. Entry mcpServers and lspServers
  // apply when the entry is the manifest.
  const appendable = new Set<keyof PluginManifest>(COMPONENT_KEYS)
  const declaredOrEntry = (key: keyof PluginManifest) =>
    (own === undefined ? [entry?.[key]] : [own[key], appendable.has(key) ? extra?.[key] : undefined]).filter(
      (value) => value !== undefined,
    )

  const context: Context = { root, name, issues }
  const skills = new Map<string, SkillDef>()
  const commands = new Map<string, CommandDef>()

  const exclusiveSkills = own === undefined && options.entryIsMarketplaceRoot === true && entry?.skills !== undefined
  const skillPaths = declaredOrEntry("skills").flatMap((value) => pathList(value, context, "skills"))
  const defaultSkills = path.join(root, "skills")
  if (!exclusiveSkills && isDirectory(defaultSkills)) loadSkillsFrom(defaultSkills, context, skills)
  for (const directory of skillPaths) loadSkillsFrom(directory, context, skills)
  if (skills.size === 0 && skillPaths.length === 0 && !isDirectory(defaultSkills)) {
    const rootSkill = path.join(root, "SKILL.md")
    if (existsSync(rootSkill)) addSkill(rootSkill, `${name}:${name}`, context, skills)
  }

  const commandDecls = declaredOrEntry("commands")
  if (commandDecls.length === 0) {
    const directory = path.join(root, "commands")
    if (isDirectory(directory)) loadCommandsFrom(directory, directory, context, commands, skills)
  }
  for (const value of commandDecls) loadDeclaredCommands(value, context, commands, skills)

  const agents = new Map<string, AgentDef>()
  const agentDecls = declaredOrEntry("agents")
  if (agentDecls.length === 0) {
    const directory = path.join(root, "agents")
    if (isDirectory(directory)) loadAgentsFrom(directory, directory, context, agents)
  }
  for (const value of agentDecls) {
    for (const target of pathList(value, context, "agents")) {
      if (isDirectory(target)) loadAgentsFrom(target, target, context, agents)
      else addAgent(target, [], context, agents)
    }
  }

  const hooks: HookConfig = {}
  const defaultHooks = path.join(root, "hooks", "hooks.json")
  if (existsSync(defaultHooks)) mergeHooks(hooks, readHooksFile(defaultHooks, context))
  for (const value of own === undefined ? declaredOrEntry("hooks") : [own.hooks].filter((item) => item !== undefined))
    mergeHooks(hooks, readDeclaredHooks(value, context))
  // A strict entry's matchers replace the manifest's for the same event.
  if (own !== undefined && extra?.hooks !== undefined) Object.assign(hooks, readDeclaredHooks(extra.hooks, context))

  const mcpServers: Record<string, McpServerDef> = {}
  const unsupported: Unsupported[] = []
  const defaultMcp = path.join(root, ".mcp.json")
  if (existsSync(defaultMcp)) Object.assign(mcpServers, readMcpFile(defaultMcp, context))
  for (const value of declaredOrEntry("mcpServers"))
    Object.assign(mcpServers, readDeclaredMcp(value, context, unsupported))

  const lspServers: Record<string, LspServerDef> = {}
  const defaultLsp = path.join(root, ".lsp.json")
  if (existsSync(defaultLsp)) Object.assign(lspServers, readLspMap(readJson(defaultLsp, context), context))
  for (const value of declaredOrEntry("lspServers")) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") {
        const file = inside(item, context, "lspServers")
        if (file) Object.assign(lspServers, readLspMap(readJson(file, context), context))
        continue
      }
      Object.assign(lspServers, readLspMap(item, context))
    }
  }

  collectUnsupported(root, manifest, unsupported)
  const binDir = path.join(root, "bin")

  return {
    name,
    root,
    version: asString(own?.version) ?? asString(entry?.version),
    manifest,
    skills: [...skills.values()],
    commands: [...commands.values()],
    agents: [...agents.values()],
    hooks,
    mcpServers,
    lspServers,
    ...(isDirectory(binDir) ? { binDir } : {}),
    unsupported,
    issues,
  }
}

interface Context {
  root: string
  name: string
  issues: Issue[]
}

export function readManifest(root: string, issues: Issue[]): PluginManifest | undefined {
  const file = path.join(root, ".claude-plugin", "plugin.json")
  if (!existsSync(file)) return undefined
  const value = readJson(file, { root, name: path.basename(root), issues })
  if (isRecord(value)) return value
  issues.push({ level: "error", message: "plugin.json must be a JSON object", path: file })
  return undefined
}

function readJson(file: string, context: Context): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    context.issues.push({ level: "error", message: `Invalid JSON: ${(error as Error).message}`, path: file })
    return undefined
  }
}

function isDirectory(target: string) {
  return existsSync(target) && statSync(target).isDirectory()
}

/** Resolves a manifest path, enforcing that it stays inside the plugin root and exists. */
function inside(relative: string, context: Context, component: string): string | undefined {
  const resolved = path.resolve(context.root, relative)
  const offset = path.relative(context.root, resolved)
  if (offset.startsWith("..") || path.isAbsolute(offset)) {
    context.issues.push({ level: "error", message: `${component} path escapes plugin directory: ${relative}` })
    return undefined
  }
  if (!existsSync(resolved)) {
    context.issues.push({ level: "error", message: `${component} path not found: ${relative}` })
    return undefined
  }
  return resolved
}

function pathList(value: unknown, context: Context, component: string): string[] {
  const items = Array.isArray(value) ? value : [value]
  return items.flatMap((item) => {
    if (typeof item !== "string") {
      context.issues.push({ level: "error", message: `${component} entries must be paths` })
      return []
    }
    const resolved = inside(item, context, component)
    return resolved ? [resolved] : []
  })
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name)
      if (isDirectory(target)) return markdownFiles(target)
      return entry.name.toLowerCase().endsWith(".md") ? [target] : []
    })
}

function loadSkillsFrom(directory: string, context: Context, skills: Map<string, SkillDef>) {
  const direct = path.join(directory, "SKILL.md")
  if (existsSync(direct)) {
    const leaf = directory === context.root ? context.name : path.basename(directory)
    addSkill(direct, `${context.name}:${leaf}`, context, skills)
    return
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name, "SKILL.md")
    if (existsSync(file)) addSkill(file, `${context.name}:${entry.name}`, context, skills)
  }
}

function addSkill(file: string, id: string, context: Context, skills: Map<string, SkillDef>) {
  if (skills.has(id)) return
  const markdown = parseMarkdown(readFileSync(file, "utf8"))
  const description = asString(markdown.data.description) ?? firstParagraph(markdown.body)
  skills.set(id, {
    id,
    displayName: asString(markdown.data.name) ?? id.slice(id.lastIndexOf(":") + 1),
    ...(description === undefined ? {} : { description }),
    path: file,
    body: markdown.body,
    frontmatter: markdown.data,
    disableModelInvocation: asBoolean(markdown.data["disable-model-invocation"]) === true,
  })
  if (description === undefined)
    context.issues.push({ level: "warning", message: `Skill ${id} has no description`, path: file })
}

function firstParagraph(body: string): string | undefined {
  const line = body.split(/\r?\n/).find((item) => item.trim() !== "" && !item.trim().startsWith("#"))
  return line?.trim().slice(0, 250)
}

function loadCommandsFrom(
  directory: string,
  base: string,
  context: Context,
  commands: Map<string, CommandDef>,
  skills: Map<string, SkillDef>,
) {
  // A directory holding SKILL.md under commands/ is a skill named by that directory.
  if (existsSync(path.join(directory, "SKILL.md")) && directory !== base) {
    const segments = path.relative(base, directory).split(path.sep)
    addSkill(path.join(directory, "SKILL.md"), [context.name, ...segments].join(":"), context, skills)
    return
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const target = path.join(directory, entry.name)
    if (isDirectory(target)) {
      loadCommandsFrom(target, base, context, commands, skills)
      continue
    }
    if (!entry.name.toLowerCase().endsWith(".md")) continue
    const segments = path.relative(base, target).replace(/\.md$/i, "").split(path.sep)
    addCommand([context.name, ...segments].join(":"), readFileSync(target, "utf8"), target, {}, commands)
  }
}

function loadDeclaredCommands(
  value: unknown,
  context: Context,
  commands: Map<string, CommandDef>,
  skills: Map<string, SkillDef>,
) {
  if (isRecord(value)) {
    for (const [key, spec] of Object.entries(value)) {
      if (!isRecord(spec)) continue
      const id = `${context.name}:${key}`
      const source = asString(spec.source)
      const content = typeof spec.content === "string" ? spec.content : undefined
      if ((source === undefined) === (content === undefined)) {
        context.issues.push({ level: "error", message: `Command ${id} must set exactly one of source or content` })
        continue
      }
      const file = source === undefined ? undefined : inside(source, context, "commands")
      if (source !== undefined && file === undefined) continue
      addCommand(id, file === undefined ? content! : readFileSync(file, "utf8"), file, spec, commands)
    }
    return
  }
  for (const target of pathList(value, context, "commands")) {
    if (isDirectory(target)) {
      loadCommandsFrom(target, target, context, commands, skills)
      continue
    }
    addCommand(
      `${context.name}:${path.basename(target).replace(/\.md$/i, "")}`,
      readFileSync(target, "utf8"),
      target,
      {},
      commands,
    )
  }
}

function addCommand(
  id: string,
  text: string,
  file: string | undefined,
  overrides: Record<string, unknown>,
  commands: Map<string, CommandDef>,
) {
  if (commands.has(id)) return
  const markdown = parseMarkdown(text)
  const description = asString(overrides.description) ?? asString(markdown.data.description)
  const argumentHint = asString(overrides.argumentHint) ?? hintText(markdown.data["argument-hint"])
  const model = asString(overrides.model) ?? asString(markdown.data.model)
  const allowedTools = asStringList(overrides.allowedTools) ?? asStringList(markdown.data["allowed-tools"])
  commands.set(id, {
    id,
    ...(description === undefined ? {} : { description }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
    ...(model === undefined ? {} : { model }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    body: markdown.body,
    ...(file === undefined ? {} : { path: file }),
    frontmatter: markdown.data,
  })
}

/** YAML reads the common `argument-hint: [file]` as a list; put the brackets back. */
function hintText(value: unknown): string | undefined {
  return Array.isArray(value) ? `[${value.map(String).join(", ")}]` : asString(value)
}

function loadAgentsFrom(directory: string, base: string, context: Context, agents: Map<string, AgentDef>) {
  for (const file of markdownFiles(directory)) {
    const segments = path
      .relative(base, path.dirname(file))
      .split(path.sep)
      .filter((item) => item !== "")
    addAgent(file, segments, context, agents)
  }
}

function addAgent(file: string, segments: string[], context: Context, agents: Map<string, AgentDef>) {
  if (!file.toLowerCase().endsWith(".md")) {
    context.issues.push({ level: "error", message: "Agent files must be Markdown", path: file })
    return
  }
  const markdown = parseMarkdown(readFileSync(file, "utf8"))
  const leaf = asString(markdown.data.name) ?? path.basename(file).replace(/\.md$/i, "")
  const id = [context.name, ...segments, leaf].join(":")
  if (agents.has(id)) return
  const description = asString(markdown.data.description)
  const model = asString(markdown.data.model)
  const tools = asStringList(markdown.data.tools)
  const disallowedTools = asStringList(markdown.data.disallowedTools)
  const color = asString(markdown.data.color)
  agents.set(id, {
    id,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(color === undefined ? {} : { color }),
    body: markdown.body,
    path: file,
    frontmatter: markdown.data,
  })
}

function mergeHooks(target: HookConfig, source: HookConfig) {
  for (const [event, matchers] of Object.entries(source)) target[event] = [...(target[event] ?? []), ...matchers]
}

/** A hooks file wraps the event map in a top-level `hooks` key. */
function readHooksFile(file: string, context: Context): HookConfig {
  const value = readJson(file, context)
  if (!isRecord(value) || !isRecord(value.hooks)) {
    if (value !== undefined)
      context.issues.push({
        level: "error",
        message: 'Hooks file must wrap its event map in a "hooks" key',
        path: file,
      })
    return {}
  }
  return normalizeHooks(value.hooks, context, file)
}

function readDeclaredHooks(value: unknown, context: Context): HookConfig {
  const result: HookConfig = {}
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item === "string") {
      const file = inside(item, context, "hooks")
      if (file) mergeHooks(result, readHooksFile(file, context))
      continue
    }
    if (isRecord(item)) mergeHooks(result, normalizeHooks(isRecord(item.hooks) ? item.hooks : item, context))
  }
  return result
}

function normalizeHooks(events: Record<string, unknown>, context: Context, file?: string): HookConfig {
  const result: HookConfig = {}
  for (const [event, value] of Object.entries(events)) {
    if (!Array.isArray(value)) continue
    const matchers = value.flatMap((item): HookMatcher[] => {
      if (!isRecord(item) || !Array.isArray(item.hooks)) return []
      const hooks = item.hooks.filter((hook): hook is HookHandler => isRecord(hook) && typeof hook.type === "string")
      if (hooks.length !== item.hooks.length)
        context.issues.push({
          level: "warning",
          message: `${event} hook entries without a type were skipped`,
          path: file,
        })
      const matcher = asString(item.matcher)
      return hooks.length === 0 ? [] : [{ ...(matcher === undefined ? {} : { matcher }), hooks }]
    })
    if (matchers.length > 0) result[event] = matchers
  }
  return result
}

/** `.mcp.json` appears both wrapped in `mcpServers` and as a bare name-to-config map. */
function readMcpFile(file: string, context: Context): Record<string, McpServerDef> {
  const value = readJson(file, context)
  if (!isRecord(value)) return {}
  return readMcpMap(isRecord(value.mcpServers) ? value.mcpServers : value, context)
}

function readDeclaredMcp(value: unknown, context: Context, unsupported: Unsupported[]): Record<string, McpServerDef> {
  const result: Record<string, McpServerDef> = {}
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item === "string") {
      if (/\.(mcpb|dxt)$/i.test(item)) {
        unsupported.push({ kind: "mcp-bundle", detail: item })
        continue
      }
      const file = inside(item, context, "mcpServers")
      if (file) Object.assign(result, readMcpFile(file, context))
      continue
    }
    if (isRecord(item)) Object.assign(result, readMcpMap(item, context))
  }
  return result
}

function readMcpMap(map: Record<string, unknown>, context: Context): Record<string, McpServerDef> {
  const result: Record<string, McpServerDef> = {}
  for (const [name, config] of Object.entries(map)) {
    if (!isRecord(config)) continue
    const command = asString(config.command)
    const url = asString(config.url)
    if (command !== undefined) {
      result[name] = { type: "stdio", command, args: stringArray(config.args), env: stringRecord(config.env) }
      continue
    }
    if (url !== undefined) {
      const type = config.type === "sse" || config.type === "ws" ? config.type : "http"
      result[name] = { type, url, headers: stringRecord(config.headers) }
      continue
    }
    // Marketplaces ship connector placeholders with an empty url for the user to fill in.
    // Claude Code drops those entries; the rest of the plugin still loads.
    const placeholder = typeof config.url === "string" || typeof config.command === "string"
    context.issues.push({
      level: placeholder ? "warning" : "error",
      message: placeholder
        ? `MCP server ${name} has an empty ${typeof config.url === "string" ? "url" : "command"} and was skipped`
        : `MCP server ${name} has neither command nor url`,
    })
  }
  return result
}

function readLspMap(value: unknown, context: Context): Record<string, LspServerDef> {
  if (!isRecord(value)) return {}
  const result: Record<string, LspServerDef> = {}
  for (const [name, config] of Object.entries(value)) {
    if (!isRecord(config)) continue
    const command = asString(config.command)
    if (command === undefined || !isRecord(config.extensionToLanguage)) {
      context.issues.push({ level: "error", message: `LSP server ${name} needs command and extensionToLanguage` })
      continue
    }
    result[name] = {
      command,
      args: stringArray(config.args),
      extensionToLanguage: stringRecord(config.extensionToLanguage),
      env: stringRecord(config.env),
      ...(isRecord(config.initializationOptions) ? { initializationOptions: config.initializationOptions } : {}),
    }
  }
  return result
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function collectUnsupported(root: string, manifest: PluginManifest, unsupported: Unsupported[]) {
  const experimental = isRecord(manifest.experimental) ? manifest.experimental : {}
  const present = (key: string, location: string) =>
    manifest[key] !== undefined || experimental[key] !== undefined || existsSync(path.join(root, location))
  const kinds: [kind: string, key: string, location: string][] = [
    ["output-styles", "outputStyles", "output-styles"],
    ["monitors", "monitors", path.join("monitors", "monitors.json")],
    ["themes", "themes", "themes"],
    ["workflows", "workflows", "workflows"],
    ["settings", "settings", "settings.json"],
  ]
  for (const [kind, key, location] of kinds)
    if (present(key, location)) unsupported.push({ kind, detail: `${kind} have no opencode equivalent` })
  if (manifest.channels !== undefined)
    unsupported.push({ kind: "channels", detail: "message channels are not translated" })
  if (manifest.types !== undefined) unsupported.push({ kind: "mods", detail: "Claude Code mods are not translated" })
}
