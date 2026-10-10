import { expect, test } from "bun:test"
import { Sandbox } from "./lib/sandbox.ts"
import { target } from "./lib/targets.ts"

/**
 * The other E2E tests point git at a cached checkout. This one talks to GitHub for real, so the
 * `owner/repo` path a user types is proven end to end.
 */
test("a marketplace added from GitHub installs and loads: anthropics/skills", async () => {
  const { repo, sha } = target("anthropic-agent-skills")
  await using sandbox = new Sandbox()
  const added = await sandbox.c4oJson<{ name: string; plugins: number; sha: string }>(
    "marketplace",
    "add",
    `${repo}@${sha}`,
  )
  expect(added).toMatchObject({ name: "anthropic-agent-skills", sha })

  // These entries share the repository root as their source and each lists its own skills.
  const report = await sandbox.c4oJson<{ skills: string[] }>("install", "document-skills@anthropic-agent-skills")
  expect(report.skills.toSorted()).toEqual([
    "document-skills:docx",
    "document-skills:pdf",
    "document-skills:pptx",
    "document-skills:xlsx",
  ])

  const server = await sandbox.serve()
  const inventory = await server.waitForInventory((current) => current.skills.includes("document-skills:pdf"))
  expect(inventory.skills).toEqual(expect.arrayContaining(report.skills))
  // Skills listed by other entries of the same repository are not part of this plugin.
  expect(inventory.skills.filter((id) => id.startsWith("document-skills:"))).toHaveLength(4)
}, 300_000)
