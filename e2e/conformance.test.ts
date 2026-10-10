import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readMarketplace, resolveSource } from "../src/spec/marketplace.ts"
import { loadPlugin } from "../src/spec/plugin.ts"
import type { LoadedPlugin } from "../src/spec/types.ts"
import { fetchRepo } from "../src/store/git.ts"
import { dataDirectory, storePaths } from "../src/store/paths.ts"
import { buildReport } from "../src/translate/report.ts"
import { REPO } from "./lib/repo.ts"
import { Sandbox } from "./lib/sandbox.ts"
import { marketplaceCheckout, targetNames } from "./lib/targets.ts"

/**
 * Conformance: for every pinned marketplace, every entry must resolve, every plugin must load
 * without errors, and the real opencode binary must list every component the loader found.
 * No model is involved. Reports land in `.e2e/report/conformance/` for the compatibility matrix.
 */
const REPORTS = path.join(REPO, ".e2e", "report", "conformance")
const FULL = process.env.C4O_E2E_FULL === "1"

describe.each(targetNames)("%s", (key) => {
  test("every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it", async () => {
    await using sandbox = new Sandbox({ pluginOptions: { disable: ["mcp", "hooks", "bin"] } })
    // The loader is run on the checkout directly; opencode is fed through `c4o`, the way a user would.
    const checkout = await sandbox.addMarketplace(key)
    const read = readMarketplace(checkout)
    expect(read.issues).toEqual([])
    const marketplace = read.marketplace!

    const local: LoadedPlugin[] = []
    const external: { name: string; url: string; pin?: string }[] = []
    for (const entry of marketplace.plugins) {
      const source = resolveSource(entry.source, marketplace, read.root)
      expect({ plugin: entry.name, kind: source.kind }).not.toEqual({ plugin: entry.name, kind: "unsupported" })
      if (source.kind === "git")
        external.push({ name: entry.name, url: source.url, ...(source.sha ? { pin: source.sha } : {}) })
      if (source.kind !== "local") continue
      expect({ plugin: entry.name, exists: existsSync(source.directory) }).toEqual({ plugin: entry.name, exists: true })
      local.push(loadPlugin({ root: source.directory, entry, entryIsMarketplaceRoot: source.isMarketplaceRoot }))
    }
    const errors = local.flatMap((plugin) =>
      plugin.issues.filter((issue) => issue.level === "error").map((issue) => `${plugin.name}: ${issue.message}`),
    )
    expect(errors).toEqual([])

    mkdirSync(REPORTS, { recursive: true })
    const paths = storePaths(sandbox.env)
    writeFileSync(
      path.join(REPORTS, `${key}.json`),
      JSON.stringify(
        {
          marketplace: marketplace.name,
          entries: marketplace.plugins.length,
          external: external.length,
          plugins: local.map((plugin) =>
            buildReport({
              id: `${plugin.name}@${marketplace.name}`,
              plugin,
              dataDir: dataDirectory(paths, plugin.name),
              options: {},
            }),
          ),
        },
        null,
        2,
      ),
    )
    if (local.length === 0) return

    // Entries can list a plugin under a different name than its manifest; install by entry name.
    const entryNames = marketplace.plugins
      .filter((entry) => resolveSource(entry.source, marketplace, read.root).kind === "local")
      .map((entry) => `${entry.name}@${marketplace.name}`)
    for (let index = 0; index < entryNames.length; index += 25)
      await sandbox.c4o("install", ...entryNames.slice(index, index + 25))

    const expected = {
      skills: local.flatMap((plugin) => plugin.skills.map((skill) => skill.id)),
      commands: local.flatMap((plugin) => plugin.commands.map((command) => command.id)),
      agents: local.flatMap((plugin) => plugin.agents.map((agent) => agent.id)),
    }
    const server = await sandbox.serve()
    const missing = (inventory: { skills: string[]; commands: string[]; agents: string[] }) => ({
      skills: expected.skills.filter((id) => !inventory.skills.includes(id)),
      commands: expected.commands.filter((id) => !inventory.commands.includes(id)),
      agents: expected.agents.filter((id) => !inventory.agents.includes(id)),
    })
    const inventory = await server
      .waitForInventory((current) => Object.values(missing(current)).every((list) => list.length === 0), 90_000)
      .catch(() => server.inventory())
    expect(missing(inventory)).toEqual({ skills: [], commands: [], agents: [] })
  }, 600_000)

  // Plugins that live in other repositories: fetch each at the commit the marketplace pins and load it.
  test.skipIf(!FULL)(
    "every external plugin fetches and loads cleanly",
    async () => {
      const checkout = await marketplaceCheckout(key)
      const read = readMarketplace(checkout)
      const marketplace = read.marketplace!
      const cache = path.join(REPO, ".e2e", "cache", "plugins")
      const failures: string[] = []
      const queue = marketplace.plugins.flatMap((entry) => {
        const source = resolveSource(entry.source, marketplace, read.root)
        return source.kind === "git" ? [{ entry, source }] : []
      })
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const { entry, source } = item
          const directory = path.join(cache, `${entry.name}@${(source.sha ?? source.ref ?? "head").slice(0, 12)}`)
          try {
            if (!existsSync(directory)) await fetchRepo({ ...source, destination: directory })
            const root = source.subdir ? path.join(directory, source.subdir) : directory
            const plugin = loadPlugin({ root, entry })
            for (const issue of plugin.issues.filter((item) => item.level === "error"))
              failures.push(`${entry.name}: ${issue.message}`)
          } catch (error) {
            failures.push(`${entry.name}: ${(error as Error).message.slice(0, 200)}`)
          }
        }
      }
      await Promise.all(Array.from({ length: 8 }, worker))
      expect(failures).toEqual([])
    },
    1_800_000,
  )
})
