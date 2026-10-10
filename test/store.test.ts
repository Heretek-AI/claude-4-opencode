import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  installPlugin,
  listInstalled,
  loadActivePlugins,
  resolveRef,
  setEnabled,
  uninstallPlugin,
} from "../src/store/installs.ts"
import { addMarketplace, removeMarketplace } from "../src/store/marketplaces.ts"
import { storePaths } from "../src/store/paths.ts"
import { readKnownMarketplaces } from "../src/store/state.ts"
import { skill, tree } from "./helpers.ts"

const store = () => storePaths({ C4O_HOME: tree({}) })

/** Turns a directory into a git repository and returns a file:// URL plus its HEAD commit. */
function gitRepo(files: Record<string, string | object>) {
  const directory = tree(files)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
    })
      .toString()
      .trim()
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  return { directory, url: `file://${directory}`, sha: git("rev-parse", "HEAD") }
}

const localMarketplace = () =>
  tree({
    ".claude-plugin/marketplace.json": {
      name: "local-tools",
      plugins: [
        { name: "greeter", source: "./plugins/greeter" },
        { name: "quiet", source: "./plugins/quiet", defaultEnabled: false },
      ],
    },
    "plugins/greeter/.claude-plugin/plugin.json": { name: "greeter", version: "2.0.0" },
    "plugins/greeter/skills/hello/SKILL.md": skill("Says hello"),
    "plugins/quiet/skills/shh/SKILL.md": skill("Says nothing"),
  })

test("a local marketplace is used in place and its plugins load from their own directory", async () => {
  const paths = store()
  const root = localMarketplace()
  const added = await addMarketplace(paths, { source: "directory", path: root })
  expect(added.name).toBe("local-tools")

  const record = await installPlugin(paths, resolveRef(paths, "greeter"))
  expect(record.installPath).toBe(path.join(root, "plugins", "greeter"))
  expect(record.version).toBe("2.0.0")
  expect(loadActivePlugins(paths).map((item) => [item.id, item.plugin.skills.map((entry) => entry.id)])).toEqual([
    ["greeter@local-tools", ["greeter:hello"]],
  ])
})

test("disable hides a plugin from the runtime, enable brings it back, uninstall forgets it", async () => {
  const paths = store()
  await addMarketplace(paths, { source: "directory", path: localMarketplace() })
  const ref = resolveRef(paths, "greeter@local-tools")
  await installPlugin(paths, ref)

  setEnabled(paths, ref, false)
  expect(loadActivePlugins(paths)).toEqual([])
  expect(listInstalled(paths).map((item) => item.enabled)).toEqual([false])

  setEnabled(paths, ref, true)
  expect(loadActivePlugins(paths)).toHaveLength(1)

  uninstallPlugin(paths, ref)
  expect(listInstalled(paths)).toEqual([])
  // The marketplace's own directory is the user's, so uninstall must leave it alone.
  expect(existsSync(readKnownMarketplaces(paths)["local-tools"]!.installLocation)).toBe(true)
})

test("defaultEnabled: false installs a plugin disabled", async () => {
  const paths = store()
  await addMarketplace(paths, { source: "directory", path: localMarketplace() })
  await installPlugin(paths, resolveRef(paths, "quiet"))
  expect(listInstalled(paths).map((item) => [item.id, item.enabled])).toEqual([["quiet@local-tools", false]])
})

test("a git marketplace is cloned, and its relative plugins are copied into the cache", async () => {
  const paths = store()
  const repo = gitRepo({
    ".claude-plugin/marketplace.json": {
      name: "remote-tools",
      plugins: [{ name: "greeter", source: "./plugins/greeter" }],
    },
    "plugins/greeter/skills/hello/SKILL.md": skill("Says hello"),
  })
  const added = await addMarketplace(paths, { source: "git", url: repo.url })
  expect(added.known.sha).toBe(repo.sha)
  expect(added.known.installLocation).toBe(path.join(paths.marketplaces, "remote-tools"))

  const record = await installPlugin(paths, resolveRef(paths, "greeter"))
  // No version anywhere, so the commit identifies it.
  expect(record.version).toBe(repo.sha.slice(0, 12))
  expect(record.installPath).toBe(path.join(paths.cache, "remote-tools", "greeter", repo.sha.slice(0, 12)))
  expect(existsSync(path.join(record.installPath, "skills", "hello", "SKILL.md"))).toBe(true)

  uninstallPlugin(paths, resolveRef(paths, "greeter"))
  expect(existsSync(record.installPath)).toBe(false)
  removeMarketplace(paths, "remote-tools")
  expect(existsSync(added.known.installLocation)).toBe(false)
})

test("plugins with external git sources are fetched at their pinned commit, including subdirectories", async () => {
  const paths = store()
  const whole = gitRepo({
    ".claude-plugin/plugin.json": { name: "whole", version: "3.1.0" },
    "skills/a/SKILL.md": skill("a"),
  })
  const mono = gitRepo({ "packages/part/skills/b/SKILL.md": skill("b"), "packages/other/README.md": "unrelated" })
  const marketplace = tree({
    ".claude-plugin/marketplace.json": {
      name: "mixed",
      plugins: [
        { name: "whole", source: { source: "url", url: whole.url, sha: whole.sha } },
        { name: "part", source: { source: "git-subdir", url: mono.url, path: "packages/part", sha: mono.sha } },
      ],
    },
  })
  await addMarketplace(paths, { source: "directory", path: marketplace })

  const wholeRecord = await installPlugin(paths, resolveRef(paths, "whole"))
  expect(wholeRecord.version).toBe("3.1.0")
  expect(wholeRecord.gitCommitSha).toBe(whole.sha)
  expect(existsSync(path.join(wholeRecord.installPath, ".git"))).toBe(false)

  const partRecord = await installPlugin(paths, resolveRef(paths, "part"))
  expect(existsSync(path.join(partRecord.installPath, "skills", "b", "SKILL.md"))).toBe(true)
  expect(existsSync(path.join(partRecord.installPath, "packages"))).toBe(false)

  expect(
    loadActivePlugins(paths)
      .flatMap((item) => item.plugin.skills.map((entry) => entry.id))
      .toSorted(),
  ).toEqual(["part:b", "whole:a"])
})

test("plugin directories passed directly load alongside the store and win on name clashes", async () => {
  const paths = store()
  await addMarketplace(paths, { source: "directory", path: localMarketplace() })
  await installPlugin(paths, resolveRef(paths, "greeter"))
  const override = tree({
    ".claude-plugin/plugin.json": { name: "greeter" },
    "skills/dev/SKILL.md": skill("Dev build"),
  })
  expect(
    loadActivePlugins(paths, { pluginDirs: [override] }).map((item) => [item.id, item.plugin.skills[0]!.id]),
  ).toEqual([["greeter@inline", "greeter:dev"]])
})

test("unknown plugins and ambiguous names are explained", async () => {
  const paths = store()
  await addMarketplace(paths, { source: "directory", path: localMarketplace() })
  expect(() => resolveRef(paths, "nope")).toThrow("No known marketplace lists a plugin named nope")
  expect(installPlugin(paths, { plugin: "nope", marketplace: "local-tools" })).rejects.toThrow(
    "has no plugin named nope",
  )
  expect(installPlugin(paths, { plugin: "x", marketplace: "missing" })).rejects.toThrow("Unknown marketplace: missing")
})

test("a marketplace added by URL is just the manifest, so only object sources install", async () => {
  const paths = store()
  const plugin = gitRepo({
    ".claude-plugin/plugin.json": { name: "remote", version: "1.0.0" },
    "skills/a/SKILL.md": skill("a"),
  })
  const manifest = {
    name: "hosted",
    plugins: [
      { name: "remote", source: { source: "url", url: plugin.url, sha: plugin.sha } },
      { name: "relative", source: "./plugins/relative" },
    ],
  }
  const server = Bun.serve({ port: 0, fetch: () => Response.json(manifest) })
  try {
    const added = await addMarketplace(paths, {
      source: "url",
      url: `http://127.0.0.1:${server.port}/marketplace.json`,
    })
    expect(added.name).toBe("hosted")
    expect((await installPlugin(paths, resolveRef(paths, "remote"))).version).toBe("1.0.0")
    expect(installPlugin(paths, resolveRef(paths, "relative"))).rejects.toThrow("has no files for the relative source")
  } finally {
    server.stop(true)
  }
})

test("a plugin whose name could escape the cache directory is refused", async () => {
  const paths = store()
  const marketplace = tree({
    ".claude-plugin/marketplace.json": { name: "sketchy", plugins: [{ name: "../../outside", source: "./p" }] },
    "p/skills/a/SKILL.md": skill("a"),
  })
  await addMarketplace(paths, { source: "directory", path: marketplace })
  expect(installPlugin(paths, { plugin: "../../outside", marketplace: "sketchy" })).rejects.toThrow(
    "Cannot install plugin",
  )
})
