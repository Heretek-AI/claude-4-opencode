import { spawn } from "node:child_process"
import path from "node:path"
import { isRecord } from "../../spec/frontmatter.ts"
import type { CommandHook, HookHandler, HttpHook } from "../../spec/types.ts"
import type { ActivePlugin } from "../../store/installs.ts"
import { varContext } from "../../translate/components.ts"
import type { ClaudeToolCall } from "../../translate/tools.ts"
import { pluginEnvironment, substitute, substituteWithEnv, type VarContext } from "../../translate/vars.ts"
import { debug } from "../debug.ts"

export interface Invocation {
  event: string
  /** What matchers are tested against: the tool name for tool events, the source for SessionStart. */
  subject?: string
  /** The tool call, for `if` conditions. */
  toolCall?: ClaudeToolCall
  /** Event-specific input fields, added to the common ones. */
  payload: Record<string, unknown>
}

export interface Session {
  sessionID: string
  cwd: string
  transcriptPath?: string
}

/** The combined effect of every handler that ran for one event. */
export interface Outcome {
  /** Set when any handler blocked. Holds the reason to show the model or user. */
  blocked?: string
  /** Text handlers asked to add to the conversation. */
  context: string[]
  /** Replacement tool input from a PreToolUse handler, in Claude's field names. */
  updatedInput?: Record<string, unknown>
  ran: number
}

interface HandlerResult {
  blocked?: string
  context?: string
  updatedInput?: Record<string, unknown>
}

/** Events whose plain, non-JSON stdout is added to the conversation as context. */
const STDOUT_IS_CONTEXT = new Set(["UserPromptSubmit", "SessionStart"])
const DEFAULT_TIMEOUT_SECONDS = 60

export function hasHooks(plugins: readonly ActivePlugin[], event: string) {
  return plugins.some((active) => (active.plugin.hooks[event]?.length ?? 0) > 0)
}

/**
 * Whether any synchronous handler could run for this invocation, testing
 * matchers and `if` conditions the same way `runHooks` does. Callers use it
 * to skip expensive setup (transcript synthesis) when nothing could match.
 */
export function hasMatchingHandler(plugins: readonly ActivePlugin[], invocation: Invocation) {
  for (const active of plugins) {
    for (const matcher of active.plugin.hooks[invocation.event] ?? []) {
      if (!matcherMatches(matcher.matcher, invocation.subject)) continue
      for (const handler of matcher.hooks) {
        if (handler.async === true) continue
        if (typeof handler.if === "string" && !conditionMatches(handler.if, invocation.toolCall)) continue
        return true
      }
    }
  }
  return false
}

/**
 * Runs every matching handler of an event across all active plugins, in parallel as Claude Code
 * does, and merges their results. Any block wins.
 */
export async function runHooks(
  plugins: readonly ActivePlugin[],
  invocation: Invocation,
  session: Session,
): Promise<Outcome> {
  const tasks: Promise<HandlerResult>[] = []
  for (const active of plugins) {
    const context = varContext(active, session.cwd)
    for (const matcher of active.plugin.hooks[invocation.event] ?? []) {
      if (!matcherMatches(matcher.matcher, invocation.subject)) continue
      for (const handler of matcher.hooks) {
        if (typeof handler.if === "string" && !conditionMatches(handler.if, invocation.toolCall)) continue
        // Async handlers cannot influence the event, so they are skipped
        // before spawning any work for them.
        if (handler.async === true) continue
        const task = runHandler(handler, invocation, session, context).catch((error): HandlerResult => {
          debug("hook failed", { plugin: active.id, event: invocation.event, error: String(error) })
          return {}
        })
        tasks.push(task)
      }
    }
  }
  const results = await Promise.all(tasks)
  const blocked = results.find((result) => result.blocked !== undefined)?.blocked
  const updatedInput = results.findLast((result) => result.updatedInput !== undefined)?.updatedInput
  return {
    ...(blocked === undefined ? {} : { blocked }),
    context: results.flatMap((result) => (result.context ? [result.context] : [])),
    ...(updatedInput === undefined ? {} : { updatedInput }),
    ran: results.length,
  }
}

/** An absent, empty or `*` matcher matches everything. Otherwise it is a regex over the whole subject. */
export function matcherMatches(matcher: string | undefined, subject: string | undefined) {
  if (matcher === undefined || matcher === "" || matcher === "*") return true
  if (subject === undefined) return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(subject)
  } catch {
    return matcher === subject
  }
}

/**
 * `if` narrows a handler with a permission rule such as `Bash(git commit:*)` or `Edit(*.ts)`.
 * Bash rules test the command (`prefix:*` is a prefix match); other tools test the file path.
 */
export function conditionMatches(condition: string, call: ClaudeToolCall | undefined) {
  if (!call) return true
  const match = /^([A-Za-z_]\w*)(?:\((.*)\))?$/.exec(condition.trim())
  if (!match) return true
  if (match[1] !== call.name) return false
  const rule = match[2]
  if (rule === undefined || rule === "" || rule === "*") return true
  if (call.name === "Bash") {
    const command = String(call.input.command ?? "")
    return rule.endsWith(":*") ? command.startsWith(rule.slice(0, -2)) : glob(rule).test(command)
  }
  const file = String(call.input.file_path ?? call.input.path ?? "")
  return glob(rule).test(file) || glob(rule).test(path.basename(file))
}

function glob(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

/** Kills the whole process group when possible, falling back to the direct child. */
function killProcessGroup(child: ReturnType<typeof spawn>) {
  if (child.pid !== undefined) {
    try {
      // Negative PIDs address the group started with `detached: true`.
      // Throws on platforms without group semantics (Windows) or when exited.
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // Already exited; the `close` handler settles the promise.
  }
}

function runHandler(
  handler: HookHandler,
  invocation: Invocation,
  session: Session,
  context: VarContext,
): Promise<HandlerResult> {
  const input = {
    session_id: session.sessionID,
    ...(session.transcriptPath === undefined ? {} : { transcript_path: session.transcriptPath }),
    cwd: session.cwd,
    permission_mode: "default",
    hook_event_name: invocation.event,
    ...invocation.payload,
  }
  if (handler.type === "command") return runCommand(handler as CommandHook, input, invocation.event, session, context)
  if (handler.type === "http") return runHttp(handler as HttpHook, input, invocation.event, context)
  // prompt, agent and mcp_tool handlers are read but not run; `c4o inspect` reports them.
  return Promise.resolve({})
}

function runCommand(
  handler: CommandHook,
  input: Record<string, unknown>,
  event: string,
  session: Session,
  context: VarContext,
): Promise<HandlerResult> {
  if (handler.shell === "powershell") return Promise.resolve({})
  const command = substitute(handler.command, context)
  // Exec form passes each argument as is; shell form hands the whole string to bash.
  const [file, args] = Array.isArray(handler.args)
    ? [command, handler.args.map((item) => substitute(String(item), context))]
    : ["bash", ["-c", command]]
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: session.cwd,
      env: { ...process.env, ...pluginEnvironment(context) },
      stdio: ["pipe", "pipe", "pipe"],
      // A new process group, so the timeout below can kill grandchildren
      // (e.g. `sleep 30 & sleep 30`) instead of only the direct bash child.
      detached: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: HandlerResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () => {
        killProcessGroup(child)
        debug("hook timed out", { event, command })
        finish({})
      },
      (handler.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    )
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      debug("hook could not start", { event, command, error: String(error) })
      finish({})
    })
    child.on("close", (code) => {
      debug("hook ran", { event, command, code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) })
      // Exit 2 is the blocking error: stderr is the reason.
      if (code === 2) return finish({ blocked: stderr.trim() || "Blocked by hook" })
      // Any other failure is non-blocking.
      if (code !== 0) return finish({})
      finish(interpret(stdout, event))
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

async function runHttp(
  handler: HttpHook,
  input: Record<string, unknown>,
  event: string,
  context: VarContext,
): Promise<HandlerResult> {
  // Only explicitly allowlisted variables expand. Anything else stays
  // literal, so a hook cannot exfiltrate unrelated secrets from the environment.
  const allowed = handler.allowedEnvVars
  const env: Record<string, string | undefined> =
    allowed === undefined ? {} : Object.fromEntries(allowed.map((name) => [name, process.env[name]]))
  const expand = (value: string) => substituteWithEnv(value, context, env)
  const response = await fetch(expand(handler.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(Object.entries(handler.headers ?? {}).map(([key, value]) => [key, expand(value)])),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((handler.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
  })
  if (!response.ok) return {}
  return interpret(await response.text(), event)
}

/** Applies Claude Code's hook output protocol to a successful handler's stdout. */
export function interpret(stdout: string, event: string): HandlerResult {
  const trimmed = stdout.trim()
  const json = trimmed.startsWith("{") ? parse(trimmed) : undefined
  if (!isRecord(json)) return trimmed !== "" && STDOUT_IS_CONTEXT.has(event) ? { context: trimmed } : {}

  const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {}
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)
  const additional = text(specific.additionalContext)
  // `systemMessage` is a warning Claude Code shows the user. Many hooks put the explanation for a
  // block there, so it stands in when no reason is given.
  const message = text(json.systemMessage)
  const blocked = (reason: string | undefined, fallback: string): HandlerResult => ({
    ...(additional === undefined ? {} : { context: additional }),
    blocked: reason ?? message ?? fallback,
  })

  if (json.continue === false) return blocked(text(json.stopReason), "Stopped by hook")
  if (json.decision === "block") return blocked(text(json.reason), "Blocked by hook")
  if (specific.permissionDecision === "deny") return blocked(text(specific.permissionDecisionReason), "Denied by hook")
  // opencode's tool hook has no way to ask the user, so a request for confirmation fails closed.
  if (specific.permissionDecision === "ask")
    return blocked(
      `A hook requires user confirmation for this action, which is not supported here. ${text(specific.permissionDecisionReason) ?? message ?? ""}`.trim(),
      "",
    )
  // A server plugin has no channel to the user, so a non-blocking warning goes to the model instead.
  const context = [additional, message === undefined ? undefined : `Hook message: ${message}`].filter(
    (item) => item !== undefined,
  )
  return {
    ...(context.length === 0 ? {} : { context: context.join("\n\n") }),
    ...(isRecord(specific.updatedInput) ? { updatedInput: specific.updatedInput } : {}),
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
