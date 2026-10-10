import { expect, test } from "bun:test"
import { Sandbox } from "../lib/sandbox.ts"

test("installed plugins show up in opencode's inventory under their Claude Code names", async () => {
  await using sandbox = new Sandbox()
  await sandbox.addMarketplace("claude-plugins-official")
  for (const plugin of ["feature-dev", "commit-commands", "code-simplifier", "context7", "frontend-design"])
    await sandbox.c4o("install", `${plugin}@claude-plugins-official`)

  const server = await sandbox.serve()
  // Each component kind is registered separately, so wait for the last of them.
  const inventory = await server.waitForInventory(
    (current) => current.commands.includes("feature-dev:feature-dev") && current.mcp.includes("context7"),
  )
  if (process.env.C4O_E2E_DEBUG) console.log(JSON.stringify(inventory))

  expect(inventory.skills).toContain("frontend-design:frontend-design")
  expect(inventory.commands).toEqual(
    expect.arrayContaining([
      "feature-dev:feature-dev",
      "commit-commands:commit",
      "commit-commands:commit-push-pr",
      "commit-commands:clean_gone",
    ]),
  )
  expect(inventory.agents).toEqual(
    expect.arrayContaining([
      "feature-dev:code-architect",
      "feature-dev:code-explorer",
      "feature-dev:code-reviewer",
      "code-simplifier:code-simplifier",
    ]),
  )
  expect(inventory.mcp).toContain("context7")
}, 180_000)
