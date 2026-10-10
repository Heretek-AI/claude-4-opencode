import { expect, test } from "bun:test"
import path from "node:path"
import { readMarketplace, resolveSource } from "../src/spec/marketplace.ts"
import { parseMarketplaceInput } from "../src/store/marketplaces.ts"
import type { Marketplace } from "../src/spec/types.ts"
import { tree } from "./helpers.ts"

const marketplace: Marketplace = { name: "m", plugins: [] }

test("reads a marketplace from its repository root or from the file itself", () => {
  const root = tree({
    ".claude-plugin/marketplace.json": {
      name: "tools",
      owner: { name: "Me" },
      plugins: [{ name: "a", source: "./a" }, { name: "bad" }],
    },
  })
  const fromRoot = readMarketplace(root)
  expect(fromRoot.marketplace?.name).toBe("tools")
  expect(fromRoot.marketplace?.plugins.map((entry) => entry.name)).toEqual(["a"])
  expect(fromRoot.issues.map((issue) => issue.message)).toEqual(["plugins[1] needs a name and a source"])
  const fromFile = readMarketplace(path.join(root, ".claude-plugin", "marketplace.json"))
  expect(fromFile.root).toBe(root)
})

test("a directory without marketplace.json is reported", () => {
  expect(readMarketplace(tree({})).issues[0]!.message).toBe("No .claude-plugin/marketplace.json found")
})

test("relative sources resolve inside the marketplace", () => {
  expect(resolveSource("./plugins/a", marketplace, "/m")).toEqual({
    kind: "local",
    directory: "/m/plugins/a",
    isMarketplaceRoot: false,
  })
  expect(resolveSource("./", marketplace, "/m")).toEqual({ kind: "local", directory: "/m", isMarketplaceRoot: true })
  expect(resolveSource("a", { ...marketplace, metadata: { pluginRoot: "./plugins" } }, "/m")).toMatchObject({
    directory: "/m/plugins/a",
  })
  expect(resolveSource("../outside", marketplace, "/m").kind).toBe("unsupported")
})

test("object sources map to git or npm fetches", () => {
  expect(resolveSource({ source: "github", repo: "obra/superpowers", ref: "main" }, marketplace, "/m")).toEqual({
    kind: "git",
    url: "https://github.com/obra/superpowers.git",
    ref: "main",
  })
  expect(resolveSource({ source: "url", url: "https://example.com/x.git", sha: "abc" }, marketplace, "/m")).toEqual({
    kind: "git",
    url: "https://example.com/x.git",
    sha: "abc",
  })
  expect(resolveSource({ source: "git-subdir", url: "owner/mono", path: "plugins/x" }, marketplace, "/m")).toEqual({
    kind: "git",
    url: "https://github.com/owner/mono.git",
    subdir: "plugins/x",
  })
  expect(resolveSource({ source: "npm", package: "@scope/plugin", version: "^1" }, marketplace, "/m")).toEqual({
    kind: "npm",
    package: "@scope/plugin",
    version: "^1",
  })
  expect(resolveSource({ source: "pip", package: "x" }, marketplace, "/m").kind).toBe("unsupported")
})

test("marketplace add accepts shorthand, URLs and local paths", () => {
  const local = tree({ ".claude-plugin/marketplace.json": { name: "m", plugins: [] } })
  expect(parseMarketplaceInput(local, "/")).toEqual({ source: "directory", path: local })
  expect(parseMarketplaceInput("anthropics/claude-plugins-official", "/nowhere")).toEqual({
    source: "github",
    repo: "anthropics/claude-plugins-official",
  })
  expect(parseMarketplaceInput("owner/repo@v2", "/nowhere")).toEqual({
    source: "github",
    repo: "owner/repo",
    ref: "v2",
  })
  expect(parseMarketplaceInput("https://gitlab.com/team/plugins.git#main", "/nowhere")).toEqual({
    source: "git",
    url: "https://gitlab.com/team/plugins.git",
    ref: "main",
  })
  expect(parseMarketplaceInput("git@github.com:owner/repo.git", "/nowhere")).toEqual({
    source: "git",
    url: "git@github.com:owner/repo.git",
  })
  expect(() => parseMarketplaceInput("./does-not-exist", "/nowhere")).toThrow("Not a marketplace source")
})

test("reserved marketplace names are only accepted from the anthropics GitHub organization", async () => {
  const { addMarketplace } = await import("../src/store/marketplaces.ts")
  const { storePaths } = await import("../src/store/paths.ts")
  const impostor = tree({ ".claude-plugin/marketplace.json": { name: "claude-plugins-official", plugins: [] } })
  await expect(
    addMarketplace(storePaths({ C4O_HOME: tree({}) }), { source: "directory", path: impostor }),
  ).rejects.toThrow("reserved for official Anthropic marketplaces")
})

test("http(s) URLs are git repositories when they look like one, otherwise a marketplace.json link", () => {
  expect(parseMarketplaceInput("https://github.com/acme/tools", "/nowhere")).toEqual({
    source: "git",
    url: "https://github.com/acme/tools",
  })
  expect(parseMarketplaceInput("https://dev.azure.com/org/proj/_git/plugins", "/nowhere")).toEqual({
    source: "git",
    url: "https://dev.azure.com/org/proj/_git/plugins",
  })
  expect(parseMarketplaceInput("https://example.com/catalog/marketplace.json", "/nowhere")).toEqual({
    source: "url",
    url: "https://example.com/catalog/marketplace.json",
  })
})

test("marketplace names follow Claude Code's rules", async () => {
  const { assertNameAllowed } = await import("../src/store/marketplaces.ts")
  const local = { source: "directory", path: "/x" } as const
  const official = { source: "github", repo: "anthropics/skills" } as const
  expect(() => assertNameAllowed("my-tools", local)).not.toThrow()
  // Names become directories, so anything that could leave the store is refused.
  for (const name of ["../escape", "a/b", ".hidden", "has space", "a..b", ""])
    expect(() => assertNameAllowed(name, local)).toThrow("Cannot use marketplace name")
  // Reserved for Anthropic, including other spellings, unless it really comes from anthropics.
  for (const name of ["anthropic-agent-skills", "claude.code.plugins", "knowledge-work-plugins"])
    expect(() => assertNameAllowed(name, local)).toThrow("reserved for official Anthropic marketplaces")
  expect(() => assertNameAllowed("anthropic-agent-skills", official)).not.toThrow()
  expect(() => assertNameAllowed("official-claude-plugins", local)).toThrow("impersonates")
  // Names with a meaning of their own, and members of every JavaScript object.
  for (const name of ["inline", "builtin", "NPM", "constructor", "toString", "claudeai-team"])
    expect(() => assertNameAllowed(name, local)).toThrow("is reserved and cannot be registered")
})

test("malicious marketplace inputs are rejected", () => {
  // Shorthand ref starting with `-` would be parsed as a git flag (e.g. --upload-pack).
  for (const input of [
    "owner/repo@--upload-pack",
    "owner/repo@--upload-pack=touch",
    "owner/repo@-evil",
    "owner/repo#--upload-pack",
    "owner/repo#--upload-pack=x",
  ]) {
    expect(() => parseMarketplaceInput(input, "/nowhere")).toThrow("Not a marketplace source")
  }
  // Repos containing `..` must not be accepted as shorthand.
  for (const input of ["owner/a..b", "owner/..", "owner/...."]) {
    expect(() => parseMarketplaceInput(input, "/nowhere")).toThrow("Not a marketplace source")
  }
  // URLs starting with `-` would be parsed as git options by `remote add` / `fetch`.
  expect(() => parseMarketplaceInput("-evil", "/nowhere")).toThrow("Not a marketplace source")
  expect(() => parseMarketplaceInput("--upload-pack=touch", "/nowhere")).toThrow("Not a marketplace source")
  // ext:: URLs execute arbitrary commands via git's ext transport.
  for (const input of ["ext::sh -c touch", "EXT::sh -c touch", "  ext::sh -c touch"]) {
    expect(() => parseMarketplaceInput(input, "/nowhere")).toThrow("Not a marketplace source")
  }
  // A git URL with a flag-like ref is rejected too.
  expect(() => parseMarketplaceInput("https://github.com/acme/tools.git#--upload-pack=x", "/nowhere")).toThrow(
    "Not a marketplace source",
  )
})
