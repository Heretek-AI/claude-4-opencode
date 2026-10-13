import type { ActivePlugin } from "../store/installs.ts"
import type { AgentDef, LspServerDef, McpServerDef, SkillDef } from "../spec/types.ts"
import { agentPermissions, type PermissionRule } from "./tools.ts"
import { pluginEnvironment, substitute, substituteWithEnv, type VarContext } from "./vars.ts"

export function varContext(active: ActivePlugin, projectDir: string): VarContext {
  return { pluginRoot: active.plugin.root, pluginData: active.dataDir, projectDir, userConfig: active.options }
}

/** Shape of opencode's `Skill.Info`. */
export interface OpencodeSkill {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export function toSkill(skill: SkillDef, context: VarContext): OpencodeSkill {
  return {
    id: skill.id,
    name: skill.id,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.disableModelInvocation ? { autoinvoke: false } : {}),
    path: skill.path,
    content: substitute(skill.body, context),
  }
}

export interface OpencodeAgent {
  id: string
  description?: string
  system: string
  mode: "subagent"
  color?: string
  permissions: PermissionRule[]
}

/**
 * Claude model aliases (`sonnet`, `opus`, `inherit`) have no provider-neutral meaning in opencode,
 * so translated agents inherit the session's model.
 *
 * Drift G: `permissions` only covers built-in tools. MCP/plugin tool names (`mcp__*`) map to
 * nothing and grant nothing (fail-closed). Mapping them to `shell`/`read` would over-privilege
 * read-only agents, so an allowlist mentioning MCP tools stays deny-all until an opt-in exists.
 */
export function toAgent(agent: AgentDef, context: VarContext): OpencodeAgent {
  return {
    id: agent.id,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    system: substitute(agent.body, context).trim(),
    mode: "subagent",
    ...(agent.color === undefined ? {} : { color: agent.color }),
    permissions: agentPermissions(agent.tools, agent.disallowedTools),
  }
}

export type OpencodeMcp =
  | { type: "local"; command: string[]; environment: Record<string, string> }
  | { type: "remote"; url: string; headers?: Record<string, string> }

/**
 * opencode derives tool names from the server name, and model providers restrict tool names to
 * `[A-Za-z0-9_-]`, so Claude's `plugin:<plugin>:<server>` form cannot be used as is.
 *
 * The encoding is collision-free and keeps the plugin/server boundary unambiguous: `-` is the
 * escape character (`-` becomes `--`, `_` becomes `-5f-`, any other character outside
 * `[A-Za-z0-9]` becomes `-<lowercase hex codepoint>-`), so an encoded part never contains a bare
 * `_`. Joining with a single `_` separator is therefore uniquely splittable, and the
 * `plugin === server` single form (no separator) never collides with a joined form.
 */
export function encodeMcpPart(value: string) {
  let out = ""
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch
    else if (ch === "-") out += "--"
    else if (ch === "_") out += "-5f-"
    else out += `-${ch.codePointAt(0)!.toString(16)}-`
  }
  return out
}

export function mcpServerName(plugin: string, server: string) {
  const encodedPlugin = encodeMcpPart(plugin)
  const encodedServer = encodeMcpPart(server)
  return plugin === server ? encodedServer : `${encodedPlugin}_${encodedServer}`
}

export function toMcp(server: McpServerDef, context: VarContext, env: Record<string, string | undefined>): OpencodeMcp {
  const expand = (value: string) => substituteWithEnv(value, context, env)
  const expandAll = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]))
  if (server.type === "stdio") {
    // Drift D-2: `cwd`/`timeout` are retained on McpServerDef for reporting but not forwarded —
    // OpencodeMcp local has no such keys, and a shell-wrapper would break tool routing. Absolute
    // `${CLAUDE_PLUGIN_ROOT}` expansion (drift E) already covers the common cwd use.
    // Drift F: pluginEnvironment is an intentional Claude-parity superset opencode does not provide.
    return {
      type: "local",
      command: [expand(server.command), ...server.args.map(expand)],
      environment: { ...pluginEnvironment(context), ...expandAll(server.env) },
    }
  }
  const headers = expandAll(server.headers)
  return { type: "remote", url: expand(server.url), ...(Object.keys(headers).length === 0 ? {} : { headers }) }
}

/** Shape of an entry in opencode's `lsp` config block. */
export interface OpencodeLsp {
  command: string[]
  extensions: string[]
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

export function toLsp(server: LspServerDef, context: VarContext, env: Record<string, string | undefined>): OpencodeLsp {
  const expand = (value: string) => substituteWithEnv(value, context, env)
  const serverEnv = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)]))
  return {
    command: [expand(server.command), ...server.args.map(expand)],
    extensions: Object.keys(server.extensionToLanguage),
    ...(Object.keys(serverEnv).length === 0 ? {} : { env: serverEnv }),
    ...(server.initializationOptions === undefined ? {} : { initialization: server.initializationOptions }),
  }
}
