import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { asBoolean } from "../src/spec/frontmatter.ts"
import { readMarketplace, resolveSource } from "../src/spec/marketplace.ts"
import { loadPlugin } from "../src/spec/plugin.ts"
import { REPO } from "./lib/repo.ts"
import { marketplaceCheckout, target } from "./lib/targets.ts"

/**
 * Golden files record what real Claude Code lists for each plugin after installing it from the
 * pinned marketplace (see e2e/oracle/capture.ts). The loader must name every component the same
 * way. This is the check that does not depend on our own reading of the format.
 */
const GOLDEN = path.join(REPO, "e2e", "golden")
const files = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((file) => file.endsWith(".json")) : []

interface Golden {
  claudeCode: string
  sha: string
  failed: Record<string, string>
  plugins: Record<string, { commands: string[]; skills: string[]; agents: string[] }>
}

describe.each(files.map((file) => file.replace(/\.json$/, "")))("%s matches Claude Code", (key) => {
  test("every plugin exposes the same skills, agents and slash commands", async () => {
    const golden = JSON.parse(readFileSync(path.join(GOLDEN, `${key}.json`), "utf8")) as Golden
    // A golden file is only meaningful for the commit it was captured from.
    expect(golden.sha).toBe(target(key).sha)

    const checkout = await marketplaceCheckout(key)
    const read = readMarketplace(checkout)
    const marketplace = read.marketplace!
    const ours: Golden["plugins"] = {}
    /** Ids Claude Code lists that come from a component kind this project reports as not translated. */
    const untranslated = new Set<string>()
    for (const entry of marketplace.plugins) {
      const source = resolveSource(entry.source, marketplace, read.root)
      if (source.kind !== "local" || entry.name in golden.failed) continue
      const plugin = loadPlugin({ root: source.directory, entry, entryIsMarketplaceRoot: source.isMarketplaceRoot })
      // The init event lists the skills a user can invoke. Model-only skills appear nowhere in it.
      const invocable = plugin.skills
        .filter((skill) => asBoolean(skill.frontmatter["user-invocable"]) !== false)
        .map((skill) => skill.id)
      const record = {
        // Claude Code lists user-invocable skills among its slash commands.
        commands: [...new Set([...plugin.commands.map((command) => command.id), ...invocable])].toSorted(),
        skills: invocable.toSorted(),
        agents: plugin.agents.map((agent) => agent.id).toSorted(),
      }
      if (record.commands.length + record.skills.length + record.agents.length > 0) ours[plugin.name] = record
      // Workflows surface as commands in Claude Code. They are not translated, and the plugin's
      // report must say so, which is what entitles the comparison to leave them out.
      const workflows = path.join(source.directory, "workflows")
      if (!existsSync(workflows)) continue
      expect({ plugin: plugin.name, reported: plugin.unsupported.map((item) => item.kind) }).toEqual({
        plugin: plugin.name,
        reported: expect.arrayContaining(["workflows"]),
      })
      for (const file of readdirSync(workflows)) {
        // A workflow is named by its exported `meta.name`, falling back to the file name.
        const declared = /\bname:\s*['"]([^'"]+)['"]/.exec(readFileSync(path.join(workflows, file), "utf8"))?.[1]
        untranslated.add(`${plugin.name}:${declared ?? file.replace(/\.[^.]+$/, "")}`)
      }
    }
    const translated = (ids: string[]) => ids.filter((id) => !untranslated.has(id))
    expect(Object.keys(ours).toSorted()).toEqual(Object.keys(golden.plugins).toSorted())
    for (const [name, expected] of Object.entries(golden.plugins)) {
      const mine = ours[name]!
      expect({ plugin: name, commands: mine.commands, agents: mine.agents }).toEqual({
        plugin: name,
        commands: translated(expected.commands),
        agents: expected.agents,
      })
      // Claude Code's `skills` list also carries the odd command file (one that sets
      // disable-model-invocation). So: every skill of ours is a skill there, and anything extra
      // there is something we expose as a command.
      const theirs = translated(expected.skills)
      expect({ plugin: name, missing: mine.skills.filter((id) => !theirs.includes(id)) }).toEqual({
        plugin: name,
        missing: [],
      })
      expect({ plugin: name, unexplained: theirs.filter((id) => !mine.commands.includes(id)) }).toEqual({
        plugin: name,
        unexplained: [],
      })
    }
  }, 300_000)
})
