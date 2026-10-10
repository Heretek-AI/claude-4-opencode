import { expect, test } from "bun:test"
import { chmodSync, symlinkSync } from "node:fs"
import path from "node:path"
import { loadPlugin } from "../src/spec/plugin.ts"
import type { MarketplaceEntry } from "../src/spec/types.ts"
import { loadActivePlugins } from "../src/store/installs.ts"
import { storePaths } from "../src/store/paths.ts"
import { skill, tree } from "./helpers.ts"

const errors = (plugin: ReturnType<typeof loadPlugin>) => plugin.issues.filter((issue) => issue.level === "error")

test("standard layout: every default location is discovered and namespaced", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "deploy-tools", version: "1.2.0" },
    "skills/deploy/SKILL.md": skill("Deploys the app"),
    "commands/status.md": "---\ndescription: Show status\nargument-hint: [env]\n---\nStatus of $ARGUMENTS",
    "commands/ops/rollback.md": "Roll back.",
    "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\n---\nYou review.",
    "agents/qa/tester.md": "---\ndescription: Tests\n---\nYou test.",
    "hooks/hooks.json": {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }] },
    },
    ".mcp.json": { mcpServers: { api: { command: "node", args: ["server.js"], env: { TOKEN: "x" } } } },
    ".lsp.json": { go: { command: "gopls", args: ["serve"], extensionToLanguage: { ".go": "go" } } },
    "bin/deploy-tool": "#!/bin/sh\n",
  })
  const plugin = loadPlugin({ root })
  expect(errors(plugin)).toEqual([])
  expect(plugin.name).toBe("deploy-tools")
  expect(plugin.version).toBe("1.2.0")
  expect(plugin.skills.map((item) => item.id)).toEqual(["deploy-tools:deploy"])
  expect(plugin.commands.map((item) => item.id)).toEqual(["deploy-tools:ops:rollback", "deploy-tools:status"])
  expect(plugin.commands.find((item) => item.id === "deploy-tools:status")).toMatchObject({
    description: "Show status",
    argumentHint: "[env]",
    body: "Status of $ARGUMENTS",
  })
  expect(plugin.agents.map((item) => item.id)).toEqual(["deploy-tools:qa:tester", "deploy-tools:reviewer"])
  expect(plugin.agents.find((item) => item.id === "deploy-tools:reviewer")?.tools).toEqual(["Read", "Grep"])
  expect(plugin.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }])
  expect(plugin.mcpServers.api).toEqual({ type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "x" } })
  expect(plugin.lspServers.go).toMatchObject({ command: "gopls", extensionToLanguage: { ".go": "go" } })
  expect(plugin.binDir).toBe(path.join(root, "bin"))
})

test("without a manifest the directory name is the plugin name", () => {
  const root = tree({ "skills/hello/SKILL.md": skill("Says hello") })
  const plugin = loadPlugin({ root })
  expect(plugin.name).toBe(path.basename(root))
  expect(plugin.skills[0]!.id).toBe(`${path.basename(root)}:hello`)
})

test("skill ids come from the directory, display names from frontmatter", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p" },
    "skills/dir-name/SKILL.md": "---\nname: Pretty Name\ndescription: d\ndisable-model-invocation: true\n---\nbody",
  })
  const [item] = loadPlugin({ root }).skills
  expect(item).toMatchObject({ id: "p:dir-name", displayName: "Pretty Name", disableModelInvocation: true })
})

test("manifest commands and agents replace the default scan; skills add to it", () => {
  const root = tree({
    ".claude-plugin/plugin.json": {
      name: "p",
      commands: ["./extra/one.md"],
      agents: ["./custom/helper.md"],
      skills: ["./more-skills/"],
    },
    "commands/ignored.md": "ignored",
    "extra/one.md": "one",
    "agents/ignored.md": "---\ndescription: x\n---\nignored",
    "custom/helper.md": "---\ndescription: x\n---\nhelper",
    "skills/a/SKILL.md": skill("a"),
    "more-skills/b/SKILL.md": skill("b"),
  })
  const plugin = loadPlugin({ root })
  expect(plugin.commands.map((item) => item.id)).toEqual(["p:one"])
  expect(plugin.agents.map((item) => item.id)).toEqual(["p:helper"])
  expect(plugin.skills.map((item) => item.id)).toEqual(["p:a", "p:b"])
})

test("the commands object map supports source files and inline content", () => {
  const root = tree({
    ".claude-plugin/plugin.json": {
      name: "p",
      commands: {
        status: { source: "./c/status.md", description: "Override", argumentHint: "[env]" },
        about: { content: "Explain this plugin." },
        broken: { source: "./c/status.md", content: "both" },
      },
    },
    "c/status.md": "---\ndescription: From file\n---\nStatus.",
  })
  const plugin = loadPlugin({ root })
  expect(plugin.commands.map((item) => [item.id, item.description, item.body])).toEqual([
    ["p:status", "Override", "Status."],
    ["p:about", undefined, "Explain this plugin."],
  ])
  expect(errors(plugin).map((issue) => issue.message)).toEqual([
    "Command p:broken must set exactly one of source or content",
  ])
})

test("a root SKILL.md with no skills directory loads as a single skill", () => {
  const root = tree({ ".claude-plugin/plugin.json": { name: "solo" }, "SKILL.md": skill("The only skill") })
  expect(loadPlugin({ root }).skills.map((item) => item.id)).toEqual(["solo:solo"])
})

test("a skills path that holds SKILL.md directly is one skill", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", skills: ["./tools/pdf"] },
    "tools/pdf/SKILL.md": skill("PDF"),
  })
  expect(loadPlugin({ root }).skills.map((item) => item.id)).toEqual(["p:pdf"])
})

test("manifest hooks merge with hooks/hooks.json, as files or inline", () => {
  const hook = (command: string) => ({ hooks: [{ type: "command", command }] })
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", hooks: ["./config/extra.json", { PostToolUse: [hook("inline.sh")] }] },
    "hooks/hooks.json": { hooks: { PreToolUse: [hook("default.sh")] } },
    "config/extra.json": { hooks: { PreToolUse: [hook("extra.sh")] } },
  })
  const plugin = loadPlugin({ root })
  expect(
    plugin.hooks.PreToolUse!.flatMap((matcher) => matcher.hooks.map((item) => (item as { command: string }).command)),
  ).toEqual(["default.sh", "extra.sh"])
  expect(plugin.hooks.PostToolUse).toHaveLength(1)
})

test("a hooks file without the wrapper key is rejected", () => {
  const root = tree({ "hooks/hooks.json": { PreToolUse: [] } })
  expect(errors(loadPlugin({ root })).map((issue) => issue.message)).toEqual([
    'Hooks file must wrap its event map in a "hooks" key',
  ])
})

test(".mcp.json is accepted bare or wrapped, and remote servers default to http", () => {
  const bare = tree({ ".mcp.json": { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } })
  expect(loadPlugin({ root: bare }).mcpServers.playwright).toEqual({
    type: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    env: {},
  })
  const wrapped = tree({
    ".mcp.json": {
      mcpServers: {
        github: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      },
    },
  })
  expect(loadPlugin({ root: wrapped }).mcpServers.github).toEqual({
    type: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${TOKEN}" },
  })
})

test("paths that escape the plugin root or do not exist are errors", () => {
  const root = tree({ ".claude-plugin/plugin.json": { name: "p", skills: ["../outside"], agents: ["./missing.md"] } })
  expect(errors(loadPlugin({ root })).map((issue) => issue.message)).toEqual([
    "skills path escapes plugin directory: ../outside",
    "agents path not found: ./missing.md",
  ])
})

test("with no plugin.json the marketplace entry is the manifest", () => {
  const entry: MarketplaceEntry = {
    name: "typescript-lsp",
    source: "./plugins/typescript-lsp",
    version: "1.0.0",
    strict: false,
    lspServers: {
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
        extensionToLanguage: { ".ts": "typescript" },
      },
    },
  }
  const plugin = loadPlugin({ root: tree({ "README.md": "docs" }), entry })
  expect(plugin.name).toBe("typescript-lsp")
  expect(plugin.version).toBe("1.0.0")
  expect(Object.keys(plugin.lspServers)).toEqual(["typescript"])
})

test("a strict entry adds components to an existing manifest", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p" },
    "skills/a/SKILL.md": skill("a"),
    "extra/b/SKILL.md": skill("b"),
  })
  const plugin = loadPlugin({ root, entry: { name: "p", source: "./p", skills: ["./extra"] } })
  expect(plugin.skills.map((item) => item.id)).toEqual(["p:a", "p:b"])
})

test("a non-strict entry that declares components conflicts with an existing manifest", () => {
  const root = tree({ ".claude-plugin/plugin.json": { name: "p" }, "skills/a/SKILL.md": skill("a") })
  const plugin = loadPlugin({ root, entry: { name: "p", source: "./p", strict: false, skills: ["./skills"] } })
  expect(errors(plugin).map((issue) => issue.message)).toEqual(["Plugin p has conflicting manifests"])
})

test("an entry at the marketplace root that lists skills loads only those", () => {
  const root = tree({
    "skills/pdf/SKILL.md": skill("pdf"),
    "skills/xlsx/SKILL.md": skill("xlsx"),
    "skills/docx/SKILL.md": skill("docx"),
  })
  const plugin = loadPlugin({
    root,
    entry: { name: "document-skills", source: "./", strict: false, skills: ["./skills/pdf", "./skills/xlsx"] },
    entryIsMarketplaceRoot: true,
  })
  expect(plugin.skills.map((item) => item.id)).toEqual(["document-skills:pdf", "document-skills:xlsx"])
})

test("components with no opencode equivalent are reported, not dropped silently", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", channels: [{ server: "x" }], mcpServers: "./bundle.mcpb" },
    "output-styles/terse.md": "terse",
    "monitors/monitors.json": [],
  })
  expect(
    loadPlugin({ root })
      .unsupported.map((item) => item.kind)
      .toSorted(),
  ).toEqual(["channels", "mcp-bundle", "monitors", "output-styles"])
})

test("an MCP placeholder with an empty url is skipped with a warning, not an error", () => {
  const root = tree({
    ".mcp.json": {
      mcpServers: { gmail: { type: "http", url: "" }, real: { type: "http", url: "https://x.test/mcp" } },
    },
  })
  const plugin = loadPlugin({ root })
  expect(Object.keys(plugin.mcpServers)).toEqual(["real"])
  expect(plugin.issues).toEqual([{ level: "warning", message: "MCP server gmail has an empty url and was skipped" }])
})

test("entry mcpServers and lspServers apply only when the entry is the manifest", () => {
  const servers = { mcpServers: { extra: { command: "node", args: ["x.js"] } } }
  const withManifest = tree({ ".claude-plugin/plugin.json": { name: "p" } })
  expect(loadPlugin({ root: withManifest, entry: { name: "p", source: "./p", ...servers } }).mcpServers).toEqual({})
  const bare = tree({ "README.md": "no manifest" })
  expect(Object.keys(loadPlugin({ root: bare, entry: { name: "p", source: "./p", ...servers } }).mcpServers)).toEqual([
    "extra",
  ])
})

test("a skills entry pointing at a SKILL.md file does not throw", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", skills: ["./tools/pdf/SKILL.md"] },
    "tools/pdf/SKILL.md": skill("PDF"),
  })
  let plugin: ReturnType<typeof loadPlugin> | undefined
  expect(() => {
    plugin = loadPlugin({ root })
  }).not.toThrow()
  expect(plugin!.skills.map((item) => item.id)).toEqual(["p:pdf"])
})

test("commands and agents entries pointing at files do not throw", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", commands: ["./c/one.md"], agents: ["./a/helper.md"] },
    "c/one.md": "one",
    "a/helper.md": "---\ndescription: x\n---\nhelper",
  })
  let plugin: ReturnType<typeof loadPlugin> | undefined
  expect(() => {
    plugin = loadPlugin({ root })
  }).not.toThrow()
  expect(plugin!.commands.map((item) => item.id)).toEqual(["p:one"])
  expect(plugin!.agents.map((item) => item.id)).toEqual(["p:helper"])
})

test("a skills entry pointing at a non-skill file records an issue instead of throwing", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", skills: ["./notes.txt"] },
    "notes.txt": "hello",
  })
  let plugin: ReturnType<typeof loadPlugin> | undefined
  expect(() => {
    plugin = loadPlugin({ root })
  }).not.toThrow()
  expect(plugin!.skills).toEqual([])
  expect(plugin!.issues.length).toBeGreaterThan(0)
})

test("a symlink outside the root is rejected and skipped during scans", () => {
  const outside = tree({ "evil/SKILL.md": skill("evil"), "evil.md": "evil" })
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p", skills: ["./link"] },
    "commands/ok.md": "ok",
  })
  symlinkSync(path.join(outside, "evil"), path.join(root, "link"))
  symlinkSync(path.join(outside, "evil.md"), path.join(root, "commands", "evil.md"))
  let plugin: ReturnType<typeof loadPlugin> | undefined
  expect(() => {
    plugin = loadPlugin({ root })
  }).not.toThrow()
  expect(plugin!.skills).toEqual([])
  expect(plugin!.commands.map((item) => item.id)).toEqual(["p:ok"])
  expect(errors(plugin!).some((issue) => issue.message.includes("escapes"))).toBe(true)
})

test("a symlink cycle does not overflow", () => {
  const root = tree({
    ".claude-plugin/plugin.json": { name: "p" },
    "commands/ok.md": "ok",
    "agents/a.md": "---\ndescription: x\n---\na",
    "skills/s/SKILL.md": skill("s"),
  })
  symlinkSync(root, path.join(root, "commands", "loop"))
  symlinkSync(root, path.join(root, "agents", "loop"))
  symlinkSync(path.join(root, "skills"), path.join(root, "skills", "s", "loop"))
  let plugin: ReturnType<typeof loadPlugin> | undefined
  expect(() => {
    plugin = loadPlugin({ root })
  }).not.toThrow()
  expect(plugin!.commands.map((item) => item.id)).toEqual(["p:ok"])
  expect(plugin!.skills.map((item) => item.id)).toEqual(["p:s"])
})

test("one broken plugin does not prevent others from loading", () => {
  const paths = storePaths({ C4O_HOME: tree({}) })
  const good = tree({ ".claude-plugin/plugin.json": { name: "good" }, "skills/a/SKILL.md": skill("a") })
  const bad = tree({ ".claude-plugin/plugin.json": { name: "bad" }, "skills/b/SKILL.md": skill("b") })
  // An unreadable skill makes loadPlugin throw; loadActivePlugins must skip it and keep the good one.
  chmodSync(path.join(bad, "skills", "b", "SKILL.md"), 0)
  try {
    let actives: ReturnType<typeof loadActivePlugins> | undefined
    expect(() => {
      actives = loadActivePlugins(paths, { pluginDirs: [bad, good] })
    }).not.toThrow()
    expect(actives!.map((item) => item.plugin.name)).toContain("good")
  } finally {
    chmodSync(path.join(bad, "skills", "b", "SKILL.md"), 0o644)
  }
})
