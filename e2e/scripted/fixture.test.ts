import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { REPO, Sandbox, type Server } from "../lib/sandbox.ts"
import { lastToolResult, lastUserText, systemText, toolNames, type Step } from "../lib/stub-llm.ts"
import { dataDirectory, storePaths } from "../../src/store/paths.ts"

/**
 * The probe plugin is a fixture whose every component has one observable effect, so these tests
 * pin down exact semantics. The official-plugin tests then show the same paths work on real plugins.
 */
const FIXTURE = path.join(REPO, "e2e", "fixtures", "probe-plugin")
const shell = (command: string): Step => ({ toolCalls: [{ name: "shell", arguments: { command } }] })

describe("probe plugin", () => {
  let sandbox: Sandbox
  let server: Server
  beforeAll(async () => {
    sandbox = new Sandbox({ pluginOptions: { pluginDirs: [FIXTURE] }, env: { PROBE_GREETING: "howdy" } })
    server = await sandbox.serve()
    // Each component kind is registered separately, so wait for the last of them.
    await server.waitForInventory(
      (inventory) => inventory.commands.includes("probe:echo") && inventory.mcp.includes("probe_echo"),
    )
  }, 120_000)

  afterAll(() => sandbox.dispose())

  const turn = (sessionID: string, steps: Step[], send: () => Promise<{ status: number; json: unknown }>) =>
    sandbox.turn(server, sessionID, steps, send)

  test("every component is registered under the plugin's namespace", async () => {
    const inventory = await server.inventory()
    expect(inventory.skills).toContain("probe:notes")
    expect(inventory.commands).toContain("probe:echo")
    expect(inventory.agents).toContain("probe:reader")
    expect(inventory.mcp).toContain("probe_echo")
  })

  test("hooks: session context, prompt context, blocking, input rewriting, post-tool feedback", async () => {
    const sessionID = await server.createSession()
    const requests = await turn(
      sessionID,
      [
        shell("echo FORBIDDEN"),
        shell("echo REWRITE"),
        shell("echo NOTE_ME"),
        {
          toolCalls: [{ name: "write", arguments: { path: path.join(sandbox.project, "prod.env"), content: "KEY=1" } }],
        },
        { text: "All done." },
      ],
      () => server.prompt(sessionID, "tidy up the repo"),
    )
    const [first, afterForbidden, afterRewrite, afterNote, afterWrite] = requests

    // SessionStart context is in the system prompt of every request, not just the first.
    for (const request of requests)
      expect(systemText(request)).toContain("PROBE_SESSION_CONTEXT: always answer in haiku.")
    // UserPromptSubmit stdout reaches the model with the prompt.
    expect(lastUserText(first!)).toContain("tidy up the repo")
    expect(lastUserText(first!)).toContain("PROBE_PROMPT_CONTEXT: the user prefers tabs.")

    // Exit code 2 from PreToolUse blocks the call and the model sees stderr.
    expect(lastToolResult(afterForbidden!)).toContain("probe: FORBIDDEN commands are blocked by policy")
    // updatedInput replaces the command that actually runs.
    expect(lastToolResult(afterRewrite!)).toContain("rewritten-by-hook")
    expect(lastToolResult(afterRewrite!)).not.toContain("REWRITE")
    // PostToolUse context is appended to the tool result, which is otherwise intact.
    expect(lastToolResult(afterNote!)).toContain("NOTE_ME")
    expect(lastToolResult(afterNote!)).toContain("PROBE_POST_CONTEXT: remember to run the tests.")
    // A JSON deny blocks the write, and the matcher saw it as Claude's Write tool.
    expect(lastToolResult(afterWrite!)).toContain("probe: .env files are read-only")
    expect(existsSync(path.join(sandbox.project, "prod.env"))).toBe(false)

    // The hook was handed Claude Code's input shape.
    const records = readFileSync(path.join(sandbox.project, ".probe-pre-bash.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.map((record) => record.tool_input.command)).toEqual([
      "echo FORBIDDEN",
      "echo REWRITE",
      "echo NOTE_ME",
    ])
    expect(records[0]).toMatchObject({
      session_id: sessionID,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: sandbox.project,
    })
    expect(existsSync(records[0].transcript_path)).toBe(true)
  }, 120_000)

  test("hooks: a blocked prompt never reaches the model", async () => {
    const sessionID = await server.createSession()
    const before = sandbox.stub.requests.length
    const response = await server.prompt(sessionID, "deploy with SECRET_TOKEN=abc")
    expect(response.status).toBeGreaterThanOrEqual(400)
    await Bun.sleep(500)
    expect(sandbox.stub.requests.length).toBe(before)
  }, 60_000)

  test("commands: arguments, plugin paths and shell interpolation with bin/ on PATH", async () => {
    const sessionID = await server.createSession()
    const [request] = await turn(sessionID, [{ text: "Echoed." }], () =>
      server.command(sessionID, "probe:echo", "alpha beta"),
    )
    expect(lastUserText(request!)).toContain(
      ["Echo request: alpha beta", "First word: alpha", `Plugin root: ${FIXTURE}`, "Tool says: probe-tool-output"].join(
        "\n",
      ),
    )
  }, 60_000)

  test("skills: plugin path variables are substituted in the body", async () => {
    const sessionID = await server.createSession()
    const [, afterSkill] = await turn(
      sessionID,
      [{ toolCalls: [{ name: "skill", arguments: { id: "probe:notes" } }] }, { text: "Loaded." }],
      () => server.prompt(sessionID, "take notes"),
    )
    expect(lastToolResult(afterSkill!)).toContain(`PROBE_SKILL_BODY: templates live in ${FIXTURE}/templates.`)
  }, 60_000)

  test("mcp: a stdio server starts from the plugin directory and its tool is callable", async () => {
    const sessionID = await server.createSession()
    // opencode exposes MCP tools through Code Mode: the model scripts them inside `execute`.
    const [first, afterCall] = await turn(
      sessionID,
      [
        {
          toolCalls: [{ name: "execute", arguments: { code: 'return await tools.probe_echo.shout({ text: "hi" })' } }],
        },
        { text: "Shouted." },
      ],
      () => server.prompt(sessionID, "shout hi"),
    )
    expect(systemText(first!) + lastUserText(first!)).toContain("tools.probe_echo.shout")
    // Env expansion (PROBE_GREETING from the environment) and CLAUDE_PLUGIN_ROOT both reached the server.
    expect(lastToolResult(afterCall!)).toContain(`howdy: HI (root=${FIXTURE})`)
    // Hooks see the MCP call under the name Claude Code would give it, so `mcp__...` matchers work.
    const seen = readFileSync(path.join(sandbox.project, ".probe-tools.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(seen).toContainEqual({ tool_name: "mcp__plugin_probe_echo__shout", tool_input: { text: "hi" } })
  }, 120_000)

  test("agents: the system prompt is the agent body and its tool allowlist is enforced", async () => {
    const sessionID = await server.createSession()
    const requests = await turn(
      sessionID,
      [
        {
          toolCalls: [
            {
              name: "subagent",
              arguments: { agent: "probe:reader", description: "read things", prompt: "Read the README" },
            },
          ],
        },
        {
          toolCalls: [
            { name: "write", arguments: { path: path.join(sandbox.project, "agent-wrote.txt"), content: "x" } },
          ],
        },
        { text: "I could not write." },
        { text: "Subagent finished." },
      ],
      () => server.prompt(sessionID, "investigate"),
    )
    const child = requests[1]!
    expect(systemText(child)).toContain("PROBE_AGENT_PROMPT: You only read files.")
    // Data dir uses the collision-free encoding (e.g. probe@inline -> probe-40-inline).
    expect(systemText(child)).toContain(dataDirectory(storePaths(sandbox.env), "probe@inline"))
    expect(lastUserText(child)).toContain("Read the README")
    if (process.env.C4O_E2E_DEBUG)
      console.log("child tools:", toolNames(child).join(", "), "| write result:", lastToolResult(requests[2]!))
    // tools: Read, Grep, Glob means the write is refused and nothing lands on disk.
    expect(existsSync(path.join(sandbox.project, "agent-wrote.txt"))).toBe(false)
  }, 120_000)

  test("bin/: the plugin's executables are on PATH for the model's shell calls", async () => {
    const sessionID = await server.createSession()
    const [, afterCall] = await turn(sessionID, [shell("probe-tool"), { text: "Ran it." }], () =>
      server.prompt(sessionID, "run the probe tool"),
    )
    expect(lastToolResult(afterCall!)).toContain("probe-tool-output")
  }, 60_000)
})
