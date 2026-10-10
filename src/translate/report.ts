import type { ActivePlugin } from "../store/installs.ts"
import type { Issue } from "../spec/types.ts"
import { mcpServerName } from "./components.ts"

export type Support = "supported" | "lossy" | "unsupported"

/**
 * How each Claude Code hook event maps onto opencode v2. Events not listed have no opencode
 * surface. The notes are shown to users by `c4o inspect`.
 */
export const HOOK_EVENTS: Record<string, { support: Support; note: string }> = {
  PreToolUse: {
    support: "supported",
    note: "runs before the tool; can block the call, rewrite its input and add context. A request to ask the user blocks instead",
  },
  PostToolUse: {
    support: "supported",
    note: "runs after a successful tool call; feedback is appended to the tool result",
  },
  PostToolUseFailure: {
    support: "lossy",
    note: "runs after a failed tool call; its feedback is not delivered to the model",
  },
  UserPromptSubmit: {
    support: "lossy",
    note: "runs when a prompt is submitted; context is appended to the prompt, and a blocked prompt is rejected with a generic error",
  },
  SessionStart: {
    support: "lossy",
    note: "runs before a session's first model request; context is added to the system prompt. Reports startup or resume, never clear or compact",
  },
  Stop: {
    support: "lossy",
    note: "runs when the session finishes a turn; a block continues the session with the reason as the next prompt",
  },
  SubagentStop: { support: "lossy", note: "runs when a subagent session finishes; it cannot be made to continue" },
  SessionEnd: { support: "lossy", note: "runs when a session is deleted, not when the client exits" },
}

export interface HookReport {
  event: string
  handlers: number
  support: Support
  note: string
}

export interface PluginReport {
  id: string
  name: string
  version?: string
  root: string
  skills: string[]
  commands: string[]
  agents: string[]
  mcpServers: { name: string; opencodeName: string; type: string }[]
  lspServers: string[]
  hooks: HookReport[]
  unsupported: { kind: string; detail: string }[]
  issues: Issue[]
}

/** What a plugin contributes to opencode, and what could not be translated. */
export function buildReport(active: ActivePlugin): PluginReport {
  const plugin = active.plugin
  const hooks = Object.entries(plugin.hooks).map(([event, matchers]): HookReport => {
    const handlers = matchers.flatMap((matcher) => matcher.hooks)
    const runnable = handlers.filter((handler) => handler.type === "command" || handler.type === "http").length
    const known = HOOK_EVENTS[event]
    if (!known) return { event, handlers: handlers.length, support: "unsupported", note: "no opencode equivalent" }
    if (runnable < handlers.length)
      return {
        event,
        handlers: handlers.length,
        support: "lossy",
        note: `${known.note}; only command and http handlers run`,
      }
    return { event, handlers: handlers.length, ...known }
  })
  const unsupported = [...plugin.unsupported]
  if (Object.keys(plugin.lspServers).length > 0)
    unsupported.push({ kind: "lsp", detail: "LSP servers must be copied into the opencode lsp config" })
  return {
    id: active.id,
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    root: plugin.root,
    skills: plugin.skills.map((skill) => skill.id),
    commands: plugin.commands.map((command) => command.id),
    agents: plugin.agents.map((agent) => agent.id),
    mcpServers: Object.entries(plugin.mcpServers).map(([name, server]) => ({
      name,
      opencodeName: mcpServerName(plugin.name, name),
      type: server.type,
    })),
    lspServers: Object.keys(plugin.lspServers),
    hooks,
    unsupported,
    issues: plugin.issues,
  }
}

export function formatReport(report: PluginReport): string {
  const lines = [`${report.id}${report.version ? ` (${report.version})` : ""}`, `  root: ${report.root}`]
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push(`  ${title} (${items.length}):`, ...items.map((item) => `    ${item}`))
  }
  section("skills", report.skills)
  section(
    "commands",
    report.commands.map((command) => `/${command}`),
  )
  section("agents", report.agents)
  section(
    "mcp servers",
    report.mcpServers.map((server) => `${server.opencodeName} (${server.type})`),
  )
  section(
    "hooks",
    report.hooks.map((hook) => `${hook.event} x${hook.handlers}: ${hook.support} - ${hook.note}`),
  )
  section(
    "not translated",
    report.unsupported.map((item) => `${item.kind}: ${item.detail}`),
  )
  section(
    "issues",
    report.issues.map((issue) => `${issue.level}: ${issue.message}`),
  )
  return lines.join("\n")
}
