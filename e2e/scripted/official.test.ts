import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseMarkdown } from "../../src/spec/frontmatter.ts"
import { Sandbox, type Server } from "../lib/sandbox.ts"
import { lastToolResult, lastUserText, systemText, toolNames, type Step } from "../lib/stub-llm.ts"
import { marketplaceCheckout } from "../lib/targets.ts"

/**
 * Unmodified plugins from anthropics/claude-plugins-official at the pinned commit, installed
 * together through `c4o` into one opencode instance.
 */
const PLUGINS = ["commit-commands", "feature-dev", "explanatory-output-style", "hookify", "ralph-loop"]
const shell = (command: string): Step => ({ toolCalls: [{ name: "shell", arguments: { command } }] })

describe("official plugins", () => {
  let sandbox: Sandbox
  let server: Server
  let checkout: string
  const turn = (sessionID: string, steps: Step[], send: () => Promise<{ status: number; json: unknown }>) =>
    sandbox.turn(server, sessionID, steps, send)

  beforeAll(async () => {
    checkout = await marketplaceCheckout("claude-plugins-official")
    sandbox = new Sandbox()
    await sandbox.addMarketplace("claude-plugins-official")
    for (const plugin of PLUGINS) await sandbox.c4o("install", `${plugin}@claude-plugins-official`)
    // hookify reads its rules from the project. This is the plugin's own example rule.
    mkdirSync(path.join(sandbox.project, ".claude"), { recursive: true })
    writeFileSync(
      path.join(sandbox.project, ".claude", "hookify.dangerous-rm.local.md"),
      readFileSync(path.join(checkout, "plugins/hookify/examples/dangerous-rm.local.md"), "utf8"),
    )
    server = await sandbox.serve()
    await server.waitForInventory((inventory) => inventory.commands.includes("ralph-loop:ralph-loop"))
  }, 180_000)

  afterAll(() => sandbox.dispose())

  test("explanatory-output-style: its SessionStart hook shapes every request", async () => {
    const handler = readFileSync(
      path.join(checkout, "plugins/explanatory-output-style/hooks-handlers/session-start.sh"),
      "utf8",
    )
    const expected = JSON.parse(handler.slice(handler.indexOf("{"), handler.lastIndexOf("}") + 1)).hookSpecificOutput
      .additionalContext
    const sessionID = await server.createSession()
    const [request] = await turn(sessionID, [{ text: "Hello." }], () => server.prompt(sessionID, "hello"))
    expect(systemText(request!)).toContain(expected)
  }, 120_000)

  test("commit-commands: /commit-commands:commit gathers live git context", async () => {
    const sessionID = await server.createSession()
    const [request] = await turn(sessionID, [{ text: "Committed." }], () =>
      server.command(sessionID, "commit-commands:commit"),
    )
    const prompt = lastUserText(request!)
    expect(prompt).toContain("Based on the above changes, create a single git commit.")
    // The !`git status` placeholders were replaced by output from the sandbox project.
    expect(prompt).not.toContain("!`git status`")
    expect(prompt).toContain("README.md")
    expect(prompt).toMatch(/Current branch: \S+/)
  }, 120_000)

  test("feature-dev: the command takes arguments and its agents run with their own prompt and tools", async () => {
    const agent = parseMarkdown(
      readFileSync(path.join(checkout, "plugins/feature-dev/agents/code-explorer.md"), "utf8"),
    )
    const sessionID = await server.createSession()
    const requests = await turn(
      sessionID,
      [
        {
          toolCalls: [
            {
              name: "subagent",
              arguments: {
                agent: "feature-dev:code-explorer",
                description: "trace theme code",
                prompt: "Trace how themes are applied",
              },
            },
          ],
        },
        { text: "Themes are applied in src/theme.ts." },
        { text: "Plan ready." },
      ],
      () => server.command(sessionID, "feature-dev:feature-dev", "add dark mode"),
    )
    const [parent, child] = requests
    expect(lastUserText(parent!)).toContain("Initial request: add dark mode")
    expect(systemText(child!)).toContain(agent.body.trim().slice(0, 300))
    expect(lastUserText(child!)).toContain("Trace how themes are applied")
    // tools: Glob, Grep, LS, Read, ... gives a read-only agent.
    expect(toolNames(child!)).toEqual(expect.arrayContaining(["read", "grep", "glob"]))
    for (const forbidden of ["write", "edit", "shell"]) expect(toolNames(child!)).not.toContain(forbidden)
    expect(lastToolResult(requests[2]!)).toContain("Themes are applied in src/theme.ts.")
  }, 120_000)

  test("hookify: a user rule blocks a matching shell command and leaves others alone", async () => {
    const sessionID = await server.createSession()
    mkdirSync(path.join(sandbox.project, "build"), { recursive: true })
    const [, afterBlocked, afterAllowed] = await turn(
      sessionID,
      [shell("rm -rf build"), shell("echo still-here"), { text: "Left the directory alone." }],
      () => server.prompt(sessionID, "clean the build directory"),
    )
    expect(lastToolResult(afterBlocked!)).toContain("Dangerous rm command detected")
    expect(existsSync(path.join(sandbox.project, "build"))).toBe(true)
    expect(lastToolResult(afterAllowed!)).toContain("still-here")
  }, 120_000)

  test("ralph-loop: the Stop hook feeds the prompt back until the completion promise appears", async () => {
    const sessionID = await server.createSession()
    const state = path.join(sandbox.project, ".claude", "ralph-loop.local.md")
    const requests = await turn(
      sessionID,
      [{ text: "Scaffolded the API." }, { text: "Added the tests." }, { text: "All green. <promise>DONE</promise>" }],
      () =>
        server.command(
          sessionID,
          "ralph-loop:ralph-loop",
          "Build a todo API --completion-promise DONE --max-iterations 5",
        ),
    )
    const [start, second, third] = requests
    // The command body's fenced shell block ran the plugin's setup script.
    expect(lastUserText(start!)).toContain("Ralph loop activated")
    // Each time the model stopped, the hook blocked and the same prompt came back.
    expect(lastUserText(second!).trim()).toBe("Build a todo API")
    expect(lastUserText(third!).trim()).toBe("Build a todo API")

    // The promise ends the loop: the hook removes its state and no further request is made.
    const settled = sandbox.stub.primary().length
    await Bun.sleep(1500)
    expect(sandbox.stub.primary().length).toBe(settled)
    expect(existsSync(state)).toBe(false)
  }, 180_000)
})
