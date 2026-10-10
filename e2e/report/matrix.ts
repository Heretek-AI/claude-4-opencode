/**
 * Builds the compatibility report from the artifacts of an E2E run:
 * `.e2e/report/conformance/*.json` (one per marketplace) and, when present, `.e2e/report/junit.xml`.
 *
 *   bun e2e/report/matrix.ts > COMPATIBILITY.md
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { HOOK_EVENTS, type PluginReport } from "../../src/translate/report.ts"
import { REPO } from "../lib/repo.ts"
import { target } from "../lib/targets.ts"

interface Conformance {
  marketplace: string
  entries: number
  external: number
  plugins: PluginReport[]
}

const REPORT = path.join(REPO, ".e2e", "report")
const MARK = { supported: "yes", lossy: "partial", unsupported: "no" } as const

const conformanceDir = path.join(REPORT, "conformance")
const marketplaces = (existsSync(conformanceDir) ? readdirSync(conformanceDir) : [])
  .filter((file) => file.endsWith(".json"))
  .toSorted()
  .map((file) => ({
    key: file.replace(/\.json$/, ""),
    data: JSON.parse(readFileSync(path.join(conformanceDir, file), "utf8")) as Conformance,
  }))

const version = (command: string, args: string[]) => {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim().split("\n")[0]!
  } catch {
    return "unknown"
  }
}
const sum = (plugins: PluginReport[], count: (plugin: PluginReport) => number) =>
  plugins.reduce((total, plugin) => total + count(plugin), 0)
const table = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")

const lines: string[] = [
  "# Compatibility",
  "",
  "Generated from an end-to-end run against the real opencode binary. Do not edit by hand: run `bun run e2e` and then `bun run e2e:report`.",
  "",
  `- opencode: \`${version(process.env.OPENCODE_BIN ?? "opencode", ["--version"])}\``,
  `- claude-4-opencode: \`${(JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version}\``,
  "",
  "## Marketplaces",
  "",
  "Every entry of each marketplace resolves, every in-repo plugin loads without errors, and opencode lists every skill, command and agent found. Marketplaces are pinned to the commits in `e2e/targets.lock.json`.",
  "",
  table(
    [
      "Marketplace",
      "Commit",
      "Entries",
      "In-repo plugins",
      "Skills",
      "Commands",
      "Agents",
      "MCP servers",
      "Plugins with hooks",
      "LSP servers",
    ],
    marketplaces.map(({ key, data }) => [
      `[${data.marketplace}](https://github.com/${target(key).repo})`,
      `\`${target(key).sha.slice(0, 7)}\``,
      data.entries,
      data.plugins.length,
      sum(data.plugins, (plugin) => plugin.skills.length),
      sum(data.plugins, (plugin) => plugin.commands.length),
      sum(data.plugins, (plugin) => plugin.agents.length),
      sum(data.plugins, (plugin) => plugin.mcpServers.length),
      data.plugins.filter((plugin) => plugin.hooks.length > 0).length,
      sum(data.plugins, (plugin) => plugin.lspServers.length),
    ]),
  ),
  "",
  "## Hook events",
  "",
  "How each Claude Code hook event is carried over. Events not listed have no opencode equivalent and are reported by `c4o inspect`.",
  "",
  table(
    ["Event", "Supported", "How"],
    Object.entries(HOOK_EVENTS).map(([event, info]) => [`\`${event}\``, MARK[info.support], info.note]),
  ),
  "",
]

const used = new Map<string, number>()
for (const { data } of marketplaces)
  for (const plugin of data.plugins)
    for (const hook of plugin.hooks) used.set(hook.event, (used.get(hook.event) ?? 0) + 1)
const untranslated = [...used].filter(([event]) => !(event in HOOK_EVENTS)).toSorted((a, b) => b[1] - a[1])
if (untranslated.length > 0)
  lines.push(
    "Events used by plugins in these marketplaces that are not carried over:",
    "",
    table(
      ["Event", "Plugins using it"],
      untranslated.map(([event, count]) => [`\`${event}\``, count]),
    ),
    "",
  )

const junit = path.join(REPORT, "junit.xml")
if (existsSync(junit)) {
  const xml = readFileSync(junit, "utf8")
  const unescape = (text: string) =>
    text
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  const all = Array.from(xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g), (match) => {
    const attribute = (name: string) => unescape(new RegExp(`\\b${name}="([^"]*)"`).exec(match[1]!)?.[1] ?? "")
    const body = match[3] ?? ""
    return {
      suite: attribute("classname"),
      name: attribute("name"),
      result:
        body.includes("<failure") || body.includes("<error") ? "FAIL" : body.includes("<skipped") ? "skipped" : "pass",
    }
  })
  // Setup and teardown hooks are recorded as unnamed cases.
  const cases = all.filter((item) => item.name !== "" && item.name !== "(unnamed)")
  lines.push(
    "## Scenarios",
    "",
    `${cases.filter((item) => item.result === "pass").length} passed, ${cases.filter((item) => item.result === "FAIL").length} failed, ${cases.filter((item) => item.result === "skipped").length} skipped.`,
    "",
    table(
      ["Suite", "Scenario", "Result"],
      cases.map((item) => [item.suite, item.name, item.result]),
    ),
    "",
  )
}

lines.push("## Plugins", "")
for (const { data } of marketplaces) {
  if (data.plugins.length === 0) continue
  lines.push(
    `<details><summary>${data.marketplace}: ${data.plugins.length} plugins</summary>`,
    "",
    table(
      ["Plugin", "Skills", "Commands", "Agents", "MCP", "Hooks", "Not translated"],
      data.plugins.map((plugin) => [
        plugin.name,
        plugin.skills.length,
        plugin.commands.length,
        plugin.agents.length,
        plugin.mcpServers.length,
        plugin.hooks.map((hook) => `${hook.event} (${MARK[hook.support]})`).join(", ") || "-",
        [...new Set(plugin.unsupported.map((item) => item.kind))].join(", ") || "-",
      ]),
    ),
    "",
    "</details>",
    "",
  )
}

console.log(lines.join("\n"))
