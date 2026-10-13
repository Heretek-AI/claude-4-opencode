import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"
import { REPO } from "../lib/repo.ts"
import { Sandbox, type RunEvent } from "../lib/sandbox.ts"

/**
 * Live tier: the same plugins and the same opencode binary, with a real model deciding what to do.
 * It needs a provider key in the environment and is skipped without one.
 *
 *   OPENCODE_API_KEY=... C4O_LIVE_MODEL=muse-spark-1.3-contributor-free bun test ./e2e/live
 *
 * C4O_LIVE_MODEL may be `provider/model` or a bare model id, which is looked up in `opencode models`.
 * Models vary, so each scenario gets a few attempts and asserts on tool activity, not on wording.
 */
const KEY_VARS = ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]
const keys = Object.fromEntries(KEY_VARS.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])))
const requested = process.env.C4O_LIVE_MODEL ?? "muse-spark-1.3-contributor-free"
const FIXTURE = path.join(REPO, "e2e", "fixtures", "probe-plugin")
const ATTEMPTS = 3

/** Finds the provider that serves a bare model id, preferring OpenCode Go and then Zen. */
function resolveModel(sandbox: Sandbox): string {
  if (requested.includes("/")) return requested
  const listed = execFileSync(process.env.OPENCODE_BIN ?? "opencode", ["models"], {
    env: sandbox.env,
    cwd: sandbox.project,
    encoding: "utf8",
  })
  const matches = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(`/${requested}`))
  const preferred = ["opencode-go/", "opencode/"].flatMap((prefix) => matches.filter((line) => line.startsWith(prefix)))
  const chosen = preferred[0] ?? matches[0]
  if (!chosen)
    throw new Error(`No provider in \`opencode models\` serves ${requested}. Set C4O_LIVE_MODEL to provider/model.`)
  return chosen
}

describe.skipIf(Object.keys(keys).length === 0)("live model", () => {
  let sandbox: Sandbox
  let model: string

  beforeAll(async () => {
    const probe = new Sandbox({ env: keys })
    try {
      model = resolveModel(probe)
    } finally {
      await probe.dispose()
    }
    console.log(`live model: ${model}`)
    sandbox = new Sandbox({ env: keys, liveModel: model, pluginOptions: { pluginDirs: [FIXTURE] } })
    await sandbox.addMarketplace("claude-plugins-official")
    await sandbox.c4o("install", "frontend-design@claude-plugins-official")
  }, 300_000)

  afterAll(async () => {
    const reportDir = path.join(REPO, ".e2e", "report")
    if (sandbox && existsSync(reportDir) && existsSync(sandbox.logFile)) {
      copyFileSync(sandbox.logFile, path.join(reportDir, "c4o-live.log"))
    }
    await sandbox?.dispose()
  })

  /** Runs the prompt until `accept` is satisfied by the event stream, up to ATTEMPTS times. */
  async function attempt(prompt: string, accept: (events: RunEvent[]) => boolean): Promise<RunEvent[]> {
    let events: RunEvent[] = []
    for (let index = 0; index < ATTEMPTS; index++) {
      const result = await sandbox.run(prompt, { timeoutMs: 240_000 })
      events = result.events
      if (accept(events)) return events
      const toolsUsed =
        tools(events)
          .map((item) => item.tool)
          .join(", ") || "none"
      const textSnippet = text(events).replace(/\s+/g, " ").trim().slice(0, 200)
      const err = result.stderr ? `; stderr: ${result.stderr.trim().slice(0, 300)}` : ""
      const eventSummary =
        events.length === 0 ? "; events: none" : `; events(${events.length}): ${events.map((e) => e.type).join(",")}`
      console.log(
        `attempt ${index + 1} did not satisfy the scenario; code: ${result.code}; tools: ${toolsUsed}${
          textSnippet ? `; text: "${textSnippet}"` : ""
        }${err}${eventSummary}`,
      )
    }
    return events
  }

  const tools = (events: RunEvent[]) =>
    events.flatMap((event) =>
      event.type === "tool_use" && event.part?.tool ? [{ tool: event.part.tool, state: event.part.state ?? {} }] : [],
    )
  const text = (events: RunEvent[]) =>
    events.map((event) => (event.type === "text" ? (event.part?.text ?? "") : "")).join("\n")

  test("a real model loads an official plugin's skill when the task calls for it", async () => {
    const loaded = (events: RunEvent[]) =>
      tools(events).some(
        (item) => item.tool === "skill" && JSON.stringify(item.state.input).includes("frontend-design:frontend-design"),
      )
    const events = await attempt(
      "Load the frontend-design skill with the skill tool, then tell me in one sentence what it is for. Do not write any files.",
      loaded,
    )
    expect(loaded(events)).toBe(true)
  }, 900_000)

  test("a plugin's PreToolUse hook stops a real model's tool call", async () => {
    const blocked = (events: RunEvent[]) =>
      tools(events).some(
        (item) =>
          item.tool === "shell" && JSON.stringify(item.state).includes("FORBIDDEN commands are blocked by policy"),
      )
    const events = await attempt(
      "Run the shell command `echo FORBIDDEN` exactly once and report what happened.",
      blocked,
    )
    expect(blocked(events)).toBe(true)
  }, 900_000)

  test("a plugin's SessionStart context reaches a real model", async () => {
    const quoted = (events: RunEvent[]) => /haiku/i.test(text(events))
    const events = await attempt(
      "Your instructions include a line that starts with PROBE_SESSION_CONTEXT. Quote that line exactly.",
      quoted,
    )
    expect(quoted(events)).toBe(true)
  }, 900_000)

  test("a real model calls a plugin's MCP tool", async () => {
    const called = (events: RunEvent[]) =>
      tools(events).some((item) => JSON.stringify(item.state).includes("HI (root="))
    const events = await attempt("Use the probe_echo shout tool with the text hi and show me its exact output.", called)
    expect(called(events)).toBe(true)
  }, 900_000)
})
