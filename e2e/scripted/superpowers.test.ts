import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseMarkdown } from "../../src/spec/frontmatter.ts"
import { Sandbox, type Server } from "../lib/sandbox.ts"
import { lastToolResult, lastUserText, systemText } from "../lib/stub-llm.ts"

/**
 * superpowers is the second most installed Claude Code plugin. The official marketplace lists it
 * as an external git source pinned to a commit, so installing it clones obra/superpowers from GitHub.
 */
describe("superpowers", () => {
  let sandbox: Sandbox
  let server: Server
  let root: string

  beforeAll(async () => {
    sandbox = new Sandbox()
    await sandbox.addMarketplace("claude-plugins-official")
    const report = await sandbox.c4oJson<{ installPath: string; version: string; skills: string[] }>(
      "install",
      "superpowers@claude-plugins-official",
    )
    root = report.installPath
    expect(report.skills).toContain("superpowers:using-superpowers")
    server = await sandbox.serve()
    await server.waitForInventory((inventory) => inventory.skills.includes("superpowers:brainstorming"))
  }, 240_000)

  afterAll(() => sandbox.dispose())

  test("its SessionStart hook injects the using-superpowers introduction", async () => {
    const introduction = parseMarkdown(readFileSync(path.join(root, "skills/using-superpowers/SKILL.md"), "utf8"))
    const sessionID = await server.createSession()
    const [request] = await sandbox.turn(server, sessionID, [{ text: "Ready." }], () =>
      server.prompt(sessionID, "let's build something"),
    )
    expect(systemText(request!)).toContain("You have superpowers.")
    expect(systemText(request!)).toContain(introduction.body.trim().slice(0, 200))
  }, 120_000)

  test("the model can load any of its skills by their Claude Code names", async () => {
    const skill = parseMarkdown(readFileSync(path.join(root, "skills/brainstorming/SKILL.md"), "utf8"))
    const sessionID = await server.createSession()
    const [first, afterSkill] = await sandbox.turn(
      server,
      sessionID,
      [
        { toolCalls: [{ name: "skill", arguments: { id: "superpowers:brainstorming" } }] },
        { text: "Let's brainstorm." },
      ],
      () => server.prompt(sessionID, "I have an idea for a CLI"),
    )
    expect(JSON.stringify(first!.body)).toContain("superpowers:test-driven-development")
    expect(lastToolResult(afterSkill!)).toContain(skill.body.trim().slice(0, 200))
  }, 120_000)

  test("a skill can be run as a slash command with arguments", async () => {
    const skill = parseMarkdown(readFileSync(path.join(root, "skills/brainstorming/SKILL.md"), "utf8"))
    const sessionID = await server.createSession()
    const [request] = await sandbox.turn(server, sessionID, [{ text: "Brainstorming." }], () =>
      server.command(sessionID, "superpowers:brainstorming", "a plugin translator"),
    )
    const prompt = lastUserText(request!)
    expect(prompt).toContain(`Base directory for this skill: ${path.join(root, "skills", "brainstorming")}`)
    expect(prompt).toContain(skill.body.trim().slice(0, 200))
    expect(prompt).toContain("a plugin translator")
  }, 120_000)
})
