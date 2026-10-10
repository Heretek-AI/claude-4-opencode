import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseMarkdown } from "../../src/spec/frontmatter.ts"
import { Sandbox } from "../lib/sandbox.ts"
import { lastToolResult } from "../lib/stub-llm.ts"
import { marketplaceCheckout } from "../lib/targets.ts"

test("frontend-design: the model can discover and load the plugin's skill", async () => {
  const checkout = await marketplaceCheckout("claude-plugins-official")
  const skillFile = path.join(checkout, "plugins/frontend-design/skills/frontend-design/SKILL.md")
  const skill = parseMarkdown(readFileSync(skillFile, "utf8"))

  await using sandbox = new Sandbox({
    script: [
      { toolCalls: [{ name: "skill", arguments: { id: "frontend-design:frontend-design" } }] },
      { text: "Loaded the skill." },
    ],
  })
  await sandbox.addMarketplace("claude-plugins-official")
  await sandbox.c4o("install", "frontend-design@claude-plugins-official")

  const result = await sandbox.run("Design a landing page for a bakery")
  expect(result.code).toBe(0)

  const [first, second] = sandbox.stub.primary()
  // The skill is advertised to the model under its Claude Code name, with the plugin's description.
  expect(JSON.stringify(first!.body)).toContain("frontend-design:frontend-design")
  expect(JSON.stringify(first!.body)).toContain(String(skill.data.description).slice(0, 60))
  // Loading it returns the real SKILL.md body.
  expect(lastToolResult(second!)).toContain(skill.body.trim().slice(0, 200))

  const call = result.events.find((event) => event.part?.tool === "skill")
  expect(call?.part?.state?.status).toBe("completed")
}, 180_000)
