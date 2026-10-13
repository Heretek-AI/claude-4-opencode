/**
 * Claude Code and opencode name their built-in tools and tool inputs differently.
 * Hooks and agent tool lists are written in Claude's vocabulary, so both directions are needed.
 */
import path from "node:path"
import { realpathSync, statSync } from "node:fs"

/**
 * opencode permission action for each Claude tool an agent may list in `tools`.
 * Tools absent here grant nothing: `BashOutput` and `KillShell` only manage existing shells,
 * and mapping them to `shell` would let a read-only agent run commands.
 * Drift G: MCP/plugin tools (`mcp__*`) grant nothing unless explicitly listed in `mcpAllow`
 * (fail-closed opt-in, see `toAgent`).
 */
const ACTIONS: Record<string, string[]> = {
  Read: ["read"],
  NotebookRead: ["read"],
  LS: ["read", "glob"],
  Glob: ["glob"],
  Grep: ["grep"],
  Edit: ["edit"],
  Write: ["edit"],
  MultiEdit: ["edit"],
  NotebookEdit: ["edit"],
  Bash: ["shell"],
  WebFetch: ["webfetch"],
  WebSearch: ["websearch"],
  Task: ["subagent"],
  Agent: ["subagent"],
  Skill: ["skill"],
  AskUserQuestion: ["question"],
}

/** Strips a permission-rule suffix such as `Bash(git add:*)` down to the tool name. */
export function toolName(rule: string) {
  const paren = rule.indexOf("(")
  return (paren === -1 ? rule : rule.slice(0, paren)).trim()
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const MCP_ACTION = "mcp:call"
const SERVER_RE = /^[A-Za-z0-9_.-]+$/
const TOOL_RE = /^[A-Za-z0-9_.-]+$/

interface McpTriple {
  server: string
  tool: string
  resource: string
}

/**
 * Parses an `mcpAllow` entry (`<server>:<tool>` or `<server>:*`).
 * Strict and fail-closed: no suffix-stripping — `filesystem:read_file(extra)`
 * is rejected, not stripped to an over-grant. Bare `*`, `<tool>` without a
 * server, `*:tool`, empty parts, and `$`/backtick content are rejected.
 */
function parseMcpAllowEntry(entry: unknown): McpTriple | undefined {
  if (typeof entry !== "string") return undefined
  const trimmed = entry.trim()
  if (trimmed === "" || trimmed === "*") return undefined
  if (trimmed.includes("(") || trimmed.includes(")")) return undefined
  const parts = trimmed.split(":")
  if (parts.length !== 2) return undefined
  const server = parts[0]!.trim()
  const tool = parts[1]!.trim()
  if (server === "" || server === "*" || !SERVER_RE.test(server)) return undefined
  if (tool === "") return undefined
  if (tool !== "*" && !TOOL_RE.test(tool)) return undefined
  return { server, tool, resource: `${server}:${tool}` }
}

/**
 * Parses an MCP deny spelling from `disallowedTools` into a canonical triple.
 * Accepts the canonical `server:tool` form and the `mcp__*` hook forms:
 * `mcp__<server>__<tool>` and `mcp__plugin_<plugin>_<server>__<tool>`.
 * For denies (fail-closed to more deny) a trailing `(...)` suffix is stripped
 * before parsing; allows never strip.
 */
function parseMcpHookDeny(entry: string): McpTriple | undefined {
  const stripped = toolName(entry)
  if (stripped === "" || stripped === "*") return undefined
  if (!stripped.startsWith("mcp__")) return undefined
  const rest = stripped.slice("mcp__".length)
  if (rest === "" || rest.includes("(") || rest.includes(")")) return undefined
  const halves = rest.split("__")
  if (halves.length !== 2) return undefined
  const head = halves[0]!.trim()
  const tool = halves[1]!.trim()
  if (head === "" || tool === "" || tool === "*:*") return undefined
  if (tool !== "*" && !TOOL_RE.test(tool)) return undefined
  // Head is `<server>` or `<plugin>_<server>` (encoded parts never contain a
  // bare `_`, so the last `_` segment is the server).
  const headSegments = head.split("_").filter((segment) => segment !== "")
  const server = headSegments[headSegments.length - 1] ?? ""
  if (server === "" || server === "*" || !SERVER_RE.test(server)) return undefined
  if (server === "plugin" && headSegments.length <= 1) return undefined
  return { server, tool, resource: `${server}:${tool}` }
}

function parseMcpDisallowEntry(entry: unknown): McpTriple | undefined {
  if (typeof entry !== "string") return undefined
  const trimmed = entry.trim()
  if (trimmed === "") return undefined
  // Canonical form (strip suffix for denies: more deny is fail-closed).
  const canonical = parseMcpAllowEntry(toolName(trimmed))
  if (canonical) return canonical
  return parseMcpHookDeny(trimmed)
}

/**
 * Turns an agent's `tools` allowlist, `disallowedTools` denylist, and optional
 * `mcpAllow` opt-in into opencode permission rules.
 * opencode applies the last matching rule, so the deny-all comes first,
 * built-in allows next, MCP allows after them, and all denies trail.
 *
 * Fail-closed defaults:
 * - No `mcpAllow` → zero `mcp:call` rules.
 * - `tools: ["*"]` → no MCP rules at all (`*` never implies MCP).
 * - Unscoped `mcpAllow` (`*`, `read_file`, `*:tool`) → rejected, no grant.
 * - Trailing MCP denies win over MCP allows.
 */
export function agentPermissions(
  tools: string[] | undefined,
  disallowed: string[] | undefined,
  mcpAllow?: string[] | undefined,
): PermissionRule[] {
  const rules: PermissionRule[] = []
  const actions = (names: string[]) => [...new Set(names.flatMap((name) => ACTIONS[toolName(name)] ?? []))]
  // `*` is a passthrough: no deny-all, no rules from the allowlist side.
  // It never implies MCP, so skip all MCP processing.
  if (tools !== undefined && tools.includes("*")) {
    for (const action of actions(disallowed ?? [])) rules.push({ action, resource: "*", effect: "deny" })
    return rules
  }
  const allows: McpTriple[] = []
  const seenAllow = new Set<string>()
  for (const entry of mcpAllow ?? []) {
    const parsed = parseMcpAllowEntry(entry)
    if (!parsed || seenAllow.has(parsed.resource)) continue
    seenAllow.add(parsed.resource)
    allows.push(parsed)
  }
  const needsDenyAll = (tools !== undefined || allows.length > 0) && true
  if (tools !== undefined) {
    rules.push({ action: "*", resource: "*", effect: "deny" })
    for (const action of actions(tools)) rules.push({ action, resource: "*", effect: "allow" })
  } else if (allows.length > 0) {
    rules.push({ action: "*", resource: "*", effect: "deny" })
  }
  // One allow per spelling (Code-Mode inner `<server>_<tool>` and hook
  // `mcp__plugin_*`), sharing the same `server:tool` resource triple.
  for (const allow of allows) {
    rules.push({ action: MCP_ACTION, resource: allow.resource, effect: "allow" })
    rules.push({ action: MCP_ACTION, resource: allow.resource, effect: "allow" })
  }
  for (const action of actions(disallowed ?? [])) rules.push({ action, resource: "*", effect: "deny" })
  // Trailing MCP denies win, including flips of an allowed triple and
  // standalone denies with no corresponding allow.
  const denyResources = new Set<string>()
  const denyOrder: string[] = []
  const considerDeny = (resource: string) => {
    if (denyResources.has(resource)) return
    denyResources.add(resource)
    denyOrder.push(resource)
  }
  const allowByInner = new Map<string, McpTriple>()
  for (const allow of allows) {
    allowByInner.set(`${allow.server}_${allow.tool}`, allow)
    // Wildcard allows also match specific inner denies on that server.
    if (allow.tool === "*") allowByInner.set(`${allow.server}_*`, allow)
  }
  for (const entry of disallowed ?? []) {
    if (typeof entry !== "string") continue
    const parsed = parseMcpDisallowEntry(entry)
    if (parsed) {
      considerDeny(parsed.resource)
      continue
    }
    // Code-Mode inner `<server>_<tool>`: only matched against known allows
    // to avoid ambiguous server/tool splits granting or denying blindly.
    const inner = toolName(entry).trim()
    if (inner !== "") {
      const direct = allowByInner.get(inner)
      if (direct) {
        // For a wildcard allow, deny the specific triple, not the wildcard.
        if (direct.tool === "*" && inner !== `${direct.server}_*`) {
          const toolPart = inner.slice(direct.server.length + 1)
          if (toolPart !== "" && TOOL_RE.test(toolPart)) considerDeny(`${direct.server}:${toolPart}`)
          continue
        }
        considerDeny(direct.resource)
      } else {
        // Inner spelling of a server with a wildcard allow: deny specifically.
        const underscore = inner.indexOf("_")
        if (underscore > 0) {
          const maybeServer = inner.slice(0, underscore)
          const maybeTool = inner.slice(underscore + 1)
          const wildcard = allows.find((allow) => allow.tool === "*" && allow.server === maybeServer)
          if (wildcard && maybeTool !== "" && TOOL_RE.test(maybeTool)) considerDeny(`${maybeServer}:${maybeTool}`)
        }
      }
    }
  }
  for (const resource of denyOrder) rules.push({ action: MCP_ACTION, resource, effect: "deny" })
  void needsDenyAll
  return rules
}

export interface ClaudeToolCall {
  name: string
  input: Record<string, unknown>
}

type Input = Record<string, unknown>

const pick = (input: Input, mapping: Record<string, string>): Input =>
  Object.fromEntries(
    Object.entries(mapping).flatMap(([from, to]): [string, unknown][] =>
      input[from] === undefined ? [] : [[to, input[from]]],
    ),
  )

const FIELDS: Record<string, { claude: string; fields: Record<string, string> }> = {
  // Drift A: shell `workdir` has no Claude counterpart and is intentionally unmapped. `toClaudeToolCall`
  // drops it (pinned by test) so matchers never see it, while `applyUpdatedInput` preserves it via
  // spread so hooks cannot clobber it. Forwarding it as `working_directory` would require a reverse
  // map plus fixture updates and is out of scope. WS5 adds a separate validated `cwd` field
  // (structured `{cwd: string}`, never parsed from command text) that is surfaced when valid.
  shell: { claude: "Bash", fields: { command: "command", timeout: "timeout", background: "run_in_background" } },
  read: { claude: "Read", fields: { path: "file_path", offset: "offset", limit: "limit" } },
  write: { claude: "Write", fields: { path: "file_path", content: "content" } },
  edit: {
    claude: "Edit",
    fields: { path: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" },
  },
  glob: { claude: "Glob", fields: { pattern: "pattern", path: "path" } },
  grep: { claude: "Grep", fields: { pattern: "pattern", path: "path", include: "glob" } },
  webfetch: { claude: "WebFetch", fields: { url: "url", prompt: "prompt" } },
  websearch: { claude: "WebSearch", fields: { query: "query" } },
  subagent: { claude: "Task", fields: { agent: "subagent_type", description: "description", prompt: "prompt" } },
  skill: { claude: "Skill", fields: { id: "skill" } },
  question: { claude: "AskUserQuestion", fields: { questions: "questions" } },
}

/**
 * Validates a structured shell `cwd` against `projectDir` (WS5).
 * Returns the real absolute path when valid, else `undefined` (caller uses
 * `projectDir`). Fail-closed: type gate → no `$`/backtick expansion →
 * `path.resolve` + `realpath` → containment under `projectDir` (real path +
 * sep) → must exist and be a directory. Never parses `cd <dir> && ...`
 * out of the command text.
 */
export function validateShellCwd(cwd: unknown, projectDir: string): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.trim() === "") return undefined
  if (cwd.includes("\0")) return undefined
  if (/[$`]/.test(cwd)) return undefined
  try {
    const resolved = path.resolve(projectDir, cwd)
    const realProject = realpathSync(projectDir)
    const realCwd = realpathSync(resolved)
    if (realCwd !== realProject && !realCwd.startsWith(realProject + path.sep)) return undefined
    if (!statSync(realCwd).isDirectory()) return undefined
    return realCwd
  } catch {
    return undefined
  }
}

/**
 * Describes an opencode tool call the way a Claude Code hook expects to see it.
 * Tools with no Claude counterpart keep their own name and input, so matchers can still target them.
 *
 * WS5: when `projectDir` is provided and the call is `shell` with a structured
 * `cwd`, the validated absolute cwd is included as `cwd` in the Bash input.
 * Invalid cwd is ignored (hooks see `projectDir` via the session). `workdir`
 * is still dropped, and `cd <dir> && ...` prefixes gain no cwd semantics.
 */
export function toClaudeToolCall(tool: string, input: unknown, projectDir?: string): ClaudeToolCall {
  const source: Input = typeof input === "object" && input !== null ? (input as Input) : {}
  const mapping = FIELDS[tool]
  if (!mapping) return { name: tool, input: source }
  const base = pick(source, mapping.fields)
  if (tool === "shell" && projectDir !== undefined) {
    const validated = validateShellCwd(source.cwd, projectDir)
    if (validated !== undefined) return { name: mapping.claude, input: { ...base, cwd: validated } }
  }
  return { name: mapping.claude, input: base }
}

/**
 * Applies a hook's `updatedInput`, written in Claude's field names, back onto the opencode input.
 * WS5: the original `cwd`/`workdir` are preserved via spread; hooks cannot set
 * cwd through `updatedInput` (no reverse map for it — fail-closed).
 */
export function applyUpdatedInput(tool: string, original: unknown, updated: Record<string, unknown>): unknown {
  const mapping = FIELDS[tool]
  const source: Input = typeof original === "object" && original !== null ? (original as Input) : {}
  if (!mapping) return { ...source, ...updated }
  const reverse = Object.fromEntries(Object.entries(mapping.fields).map(([from, to]) => [to, from]))
  return { ...source, ...pick(updated, reverse) }
}
