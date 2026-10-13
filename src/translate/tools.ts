/**
 * Claude Code and opencode name their built-in tools and tool inputs differently.
 * Hooks and agent tool lists are written in Claude's vocabulary, so both directions are needed.
 */

/**
 * opencode permission action for each Claude tool an agent may list in `tools`.
 * Tools absent here grant nothing: `BashOutput` and `KillShell` only manage existing shells,
 * and mapping them to `shell` would let a read-only agent run commands.
 * Drift G: MCP/plugin tools (`mcp__*`) are also absent by design (fail-closed, see `toAgent`).
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

/**
 * Turns an agent's `tools` allowlist and `disallowedTools` denylist into opencode permission rules.
 * opencode applies the last matching rule, so the deny-all comes first.
 */
export function agentPermissions(tools: string[] | undefined, disallowed: string[] | undefined): PermissionRule[] {
  const rules: PermissionRule[] = []
  const actions = (names: string[]) => [...new Set(names.flatMap((name) => ACTIONS[toolName(name)] ?? []))]
  if (tools !== undefined && !tools.includes("*")) {
    rules.push({ action: "*", resource: "*", effect: "deny" })
    for (const action of actions(tools)) rules.push({ action, resource: "*", effect: "allow" })
  }
  for (const action of actions(disallowed ?? [])) rules.push({ action, resource: "*", effect: "deny" })
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
  // map plus fixture updates and is out of scope.
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
 * Describes an opencode tool call the way a Claude Code hook expects to see it.
 * Tools with no Claude counterpart keep their own name and input, so matchers can still target them.
 */
export function toClaudeToolCall(tool: string, input: unknown): ClaudeToolCall {
  const source: Input = typeof input === "object" && input !== null ? (input as Input) : {}
  const mapping = FIELDS[tool]
  if (!mapping) return { name: tool, input: source }
  return { name: mapping.claude, input: pick(source, mapping.fields) }
}

/** Applies a hook's `updatedInput`, written in Claude's field names, back onto the opencode input. */
export function applyUpdatedInput(tool: string, original: unknown, updated: Record<string, unknown>): unknown {
  const mapping = FIELDS[tool]
  const source: Input = typeof original === "object" && original !== null ? (original as Input) : {}
  if (!mapping) return { ...source, ...updated }
  const reverse = Object.fromEntries(Object.entries(mapping.fields).map(([from, to]) => [to, from]))
  return { ...source, ...pick(updated, reverse) }
}
