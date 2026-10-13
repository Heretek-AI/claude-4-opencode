import type { Plugin } from "@opencode/plugin"
import { isRecord } from "../../spec/frontmatter.ts"
import type { ActivePlugin } from "../../store/installs.ts"
import { mcpServerName } from "../../translate/components.ts"
import { applyUpdatedInput, toClaudeToolCall, type ClaudeToolCall } from "../../translate/tools.ts"
import { debug } from "../debug.ts"
import { hasHooks, hasMatchingHandler, runHooks, type Invocation, type Outcome } from "./engine.ts"
import { writeTranscript } from "./transcript.ts"

export interface HookOptions {
  projectDir: string
  /** Where synthesized transcripts are written. */
  transcripts: string
}

interface SessionState {
  /** Context from SessionStart hooks, re-added to the system prompt on every request. Unset until they ran. */
  startContext?: string[]
  /** Shared SessionStart work so concurrent requests await one run instead of racing. */
  startContextPromise?: Promise<string[]>
  /** True while the session is continuing because a Stop hook blocked. Reported as `stop_hook_active`. */
  stopActive: boolean
  child?: boolean
}

const NOTHING: Outcome = { context: [], ran: 0 }

/**
 * Wires Claude Code hook events to the opencode surfaces that correspond to them.
 * `state.plugins` is read on every event, so installs and enables take effect without rebinding.
 */
export async function bindHooks(
  ctx: Plugin.Context,
  state: { plugins: ActivePlugin[] },
  options: HookOptions,
): Promise<() => Promise<void>> {
  const sessions = new Map<string, SessionState>()
  /** Sessions whose next prompt is one this plugin sent, which must not trigger UserPromptSubmit. */
  const internalPrompts = new Set<string>()
  /** PreToolUse context, held until the tool finishes so it can ride along with the result. */
  const pendingContext = new Map<string, { sessionID: string; context: string[] }>()
  /** Bound so a session that never sees execute.after cannot leak entries forever. */
  const MAX_PENDING_CONTEXT = 200
  let disposed = false

  const sessionState = (sessionID: string) => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created: SessionState = { stopActive: false }
    sessions.set(sessionID, created)
    return created
  }

  /** Subagents run as child sessions. Claude Code fires different events for them. */
  const isChild = async (sessionID: string) => {
    const session = sessionState(sessionID)
    if (session.child !== undefined) return session.child
    const info = unwrap(await ctx.session.get({ sessionID: sessionID as never }).catch(() => undefined))
    session.child = isRecord(info) && typeof info.parentID === "string"
    return session.child
  }

  const rememberPending = (id: string, sessionID: string, context: string[]) => {
    if (pendingContext.size >= MAX_PENDING_CONTEXT) {
      const oldest = pendingContext.keys().next()
      if (!oldest.done) pendingContext.delete(oldest.value)
    }
    pendingContext.set(id, { sessionID, context })
  }

  const run = async (sessionID: string, invocation: Invocation): Promise<Outcome> => {
    if (!hasHooks(state.plugins, invocation.event)) return NOTHING
    // Matchers and `if` conditions are cheap; the transcript round-trip is
    // not. Skip it when no handler could match this invocation.
    if (!hasMatchingHandler(state.plugins, invocation)) return NOTHING
    const transcriptPath = await ctx.session
      .context({ sessionID: sessionID as never })
      .then((value) => {
        const messages = unwrap(value)
        return writeTranscript(
          options.transcripts,
          sessionID,
          options.projectDir,
          Array.isArray(messages) ? messages : [],
        )
      })
      .catch(() => undefined)
    return runHooks(state.plugins, invocation, {
      sessionID,
      cwd: options.projectDir,
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    })
  }

  /** Names a tool call the way a Claude hook matcher expects, including plugin MCP tools. */
  const describe = (tool: string, input: unknown): ClaudeToolCall => {
    for (const active of state.plugins) {
      for (const server of Object.keys(active.plugin.mcpServers)) {
        const prefix = `${mcpServerName(active.plugin.name, server)}_`
        if (!tool.startsWith(prefix)) continue
        return {
          name: `mcp__plugin_${active.plugin.name}_${server}__${tool.slice(prefix.length)}`,
          input: isRecord(input) ? input : {},
        }
      }
    }
    return toClaudeToolCall(tool, input, options.projectDir)
  }

  const registrations = [
    await ctx.tool.hook("execute.before", async (event) => {
      if (!hasHooks(state.plugins, "PreToolUse")) return
      const call = describe(event.tool, event.input)
      const outcome = await run(event.sessionID, {
        event: "PreToolUse",
        subject: call.name,
        toolCall: call,
        payload: { tool_name: call.name, tool_input: call.input, tool_use_id: event.id },
      })
      if (outcome.blocked !== undefined) throw new Error([outcome.blocked, ...outcome.context].join("\n\n"))
      if (outcome.updatedInput) event.input = applyUpdatedInput(event.tool, event.input, outcome.updatedInput)
      if (outcome.context.length > 0) rememberPending(event.id, event.sessionID, outcome.context)
    }),

    await ctx.tool.hook("execute.after", async (event) => {
      const earlier = pendingContext.get(event.id)?.context ?? []
      pendingContext.delete(event.id)
      const name = event.status === "completed" ? "PostToolUse" : "PostToolUseFailure"
      const call = describe(event.tool, event.input)
      const outcome = await run(event.sessionID, {
        event: name,
        subject: call.name,
        toolCall: call,
        payload: {
          tool_name: call.name,
          tool_input: call.input,
          tool_use_id: event.id,
          ...(event.status === "completed"
            ? { tool_response: event.result.output ?? event.result.content ?? "" }
            : { error: event.error.message }),
        },
      })
      // A PostToolUse hook cannot undo the call. Its block reason and context are feedback for the model.
      const feedback = [...earlier, ...outcome.context, ...(outcome.blocked === undefined ? [] : [outcome.blocked])]
      if (feedback.length === 0) return
      if (event.status === "completed") {
        event.result = {
          ...event.result,
          content: [...contentParts(event.result), { type: "text", text: feedback.join("\n\n") }],
        }
        return
      }
      // On failure there is no result to extend (`execute.after` cannot fail,
      // so throwing is not a channel). The mutated error is what the model
      // sees for a failed tool call, so the feedback rides along with it.
      // Drift I: `error` is not marked mutable upstream; this relies on object identity and is
      // guarded, with a pinned E2E path for the completed-result case only.
      const text = feedback.join("\n\n").slice(0, 2000)
      debug("hook feedback on failed tool", { tool: event.tool, feedback: text.slice(0, 2000) })
      try {
        const previous = event.error.message
        ;(event.error as { message: string }).message = previous ? `${previous}\n\n${text}` : text
      } catch (error) {
        debug("hook feedback could not attach to error", { tool: event.tool, error: String(error) })
      }
    }),

    await ctx.session.hook("prompt", async (event) => {
      const session = sessionState(event.sessionID)
      if (internalPrompts.delete(event.sessionID)) return
      session.stopActive = false
      if (!hasHooks(state.plugins, "UserPromptSubmit") || (await isChild(event.sessionID))) return
      const outcome = await run(event.sessionID, { event: "UserPromptSubmit", payload: { prompt: event.prompt.text } })
      // Drift J: opencode v2 session hooks are NoFailures — throwing keeps the prompt out but the
      // API answers HTTP 500 with an empty body, so the block reason never reaches the caller.
      // This is the only channel; do not replace with context-append (lets blocked prompts through).
      if (outcome.blocked !== undefined) throw new Error(outcome.blocked)
      if (outcome.context.length > 0) event.prompt.text += `\n\n${reminder(outcome.context)}`
    }),

    await ctx.session.hook("context", async (event) => {
      const session = sessionState(event.sessionID)
      if (session.startContext === undefined) {
        // Share one promise so concurrent requests await the same run
        // instead of racing: the first claims the slot, the rest join it.
        session.startContextPromise ??= (async (): Promise<string[]> => {
          if (!hasHooks(state.plugins, "SessionStart") || (await isChild(event.sessionID))) return []
          const source = event.messages.length > 1 ? "resume" : "startup"
          const outcome = await run(event.sessionID, {
            event: "SessionStart",
            subject: source,
            payload: { source, model: event.model.id },
          })
          return outcome.context
        })().catch((error): string[] => {
          debug("SessionStart hooks failed", { error: String(error) })
          return []
        })
        session.startContext = await session.startContextPromise
      }
      // The system prompt is rebuilt per request, so the context is added each time.
      for (const text of session.startContext)
        event.system.push({ type: "text", text } as (typeof event.system)[number])
    }),
  ]

  const onEvent = async (event: { type: string; data?: unknown }) => {
    const sessionID =
      isRecord(event.data) && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
    if (sessionID === undefined) return
    if (event.type === "session.deleted") {
      await run(sessionID, { event: "SessionEnd", payload: { reason: "other" } })
      sessions.delete(sessionID)
      for (const [id, pending] of pendingContext) {
        if (pending.sessionID === sessionID) pendingContext.delete(id)
      }
      return
    }
    if (event.type !== "session.execution.succeeded") return
    const child = await isChild(sessionID)
    const name = child ? "SubagentStop" : "Stop"
    if (!hasHooks(state.plugins, name)) return
    const session = sessionState(sessionID)
    const outcome = await run(sessionID, { event: name, payload: { stop_hook_active: session.stopActive } })
    // Disposal may have landed while run() was suspended; do not prompt after teardown.
    if (disposed) return
    // The parent has already consumed a subagent's result, so a child cannot be made to continue.
    if (outcome.blocked === undefined || child) {
      session.stopActive = false
      return
    }
    session.stopActive = true
    internalPrompts.add(sessionID)
    await ctx.session.prompt({ sessionID: sessionID as never, text: outcome.blocked })
  }

  void (async () => {
    const events = (await ctx.event.subscribe()) as unknown as AsyncIterable<{ type: string; data?: unknown }>
    for await (const event of events) {
      if (disposed) return
      // Handle each event on its own so a slow Stop hook does not hold up the stream.
      void onEvent(event).catch((error) => debug("event hook failed", { type: event.type, error: String(error) }))
    }
  })().catch((error) => debug("event stream ended", { error: String(error) }))

  return async () => {
    disposed = true
    // Cleanup may be async: await registration disposals so hooks are
    // unregistered before the host considers teardown complete.
    await Promise.all(registrations.map((registration) => registration.dispose()))
  }
}

/** Hook context is delivered to the model the way Claude Code delivers it: as a system reminder. */
function reminder(context: string[]) {
  return `<system-reminder>\n${context.join("\n\n")}\n</system-reminder>`
}

/** API calls answer either the value itself or `{ data }`. */
function unwrap(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value
}

/** The parts the model would see for a result, following opencode's own normalization. */
function contentParts(result: { output?: unknown; content?: string | ReadonlyArray<unknown> }): never[] {
  if (typeof result.content === "string") return [{ type: "text", text: result.content }] as never[]
  if (result.content !== undefined && result.content.length > 0) return [...result.content] as never[]
  const output = result.output
  return [
    { type: "text", text: typeof output === "string" ? output : (JSON.stringify(output) ?? String(output)) },
  ] as never[]
}
