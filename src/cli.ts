#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser/lib/esm/main.js"
import { loadPlugin } from "./spec/plugin.ts"
import {
  formatId,
  installPlugin,
  listInstalled,
  loadActivePlugins,
  resolveRef,
  setEnabled,
  uninstallPlugin,
  type ActivePlugin,
} from "./store/installs.ts"
import { addMarketplace, parseMarketplaceInput, removeMarketplace, updateMarketplace } from "./store/marketplaces.ts"
import { dataDirectory, storePaths } from "./store/paths.ts"
import { readKnownMarketplaces } from "./store/state.ts"
import { buildReport, formatReport } from "./translate/report.ts"

const USAGE = `c4o - run Claude Code plugins and marketplaces on opencode v2

Usage:
  c4o marketplace add <owner/repo[@ref] | git-url[#ref] | marketplace.json-url | path>
  c4o marketplace list
  c4o marketplace update [name]
  c4o marketplace remove <name>
  c4o install <plugin>[@marketplace] [more plugins...]
  c4o uninstall <plugin>[@marketplace] [--keep-data]
  c4o enable <plugin>[@marketplace]
  c4o disable <plugin>[@marketplace]
  c4o update [plugin[@marketplace] ...]
  c4o list
  c4o inspect <plugin>[@marketplace] | <plugin directory>
  c4o setup
  c4o doctor

Options:
  --json     Machine-readable output
  --help     Show this text

The store lives in $C4O_HOME, or $XDG_DATA_HOME/opencode/claude-plugins.`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, help: { type: "boolean" }, "keep-data": { type: "boolean" } },
  })
  const [command, ...rest] = positionals
  if (values.help || command === undefined) {
    console.log(USAGE)
    return command === undefined && !values.help ? 1 : 0
  }
  const paths = storePaths()
  const print = (value: unknown, text: string) => console.log(values.json ? JSON.stringify(value, null, 2) : text)
  const need = (value: string | undefined, what: string) => {
    if (value === undefined) throw new Error(`Missing ${what}. Run c4o --help.`)
    return value
  }

  if (command === "marketplace") {
    const [action, target] = rest
    if (action === "add") {
      const result = await addMarketplace(
        paths,
        parseMarketplaceInput(need(target, "marketplace source"), process.cwd()),
      )
      const count = result.read.marketplace!.plugins.length
      print(
        { name: result.name, plugins: count, ...result.known },
        `Added marketplace ${result.name} (${count} plugins)`,
      )
      return 0
    }
    if (action === "list") {
      const known = readKnownMarketplaces(paths)
      const rows = Object.entries(known).map(([name, item]) => ({ name, ...item }))
      print(rows, rows.map((row) => `${row.name}\t${describeOrigin(row.source)}`).join("\n") || "No marketplaces added")
      return 0
    }
    if (action === "update") {
      const names = target === undefined ? Object.keys(readKnownMarketplaces(paths)) : [target]
      const updated = []
      for (const name of names) updated.push((await updateMarketplace(paths, name)).name)
      print(updated, updated.map((name) => `Updated ${name}`).join("\n") || "No marketplaces to update")
      return 0
    }
    if (action === "remove") {
      removeMarketplace(paths, need(target, "marketplace name"))
      print({ removed: target }, `Removed marketplace ${target}`)
      return 0
    }
    throw new Error(`Unknown marketplace action: ${action ?? "(none)"}. Run c4o --help.`)
  }

  if (command === "install") {
    need(rest[0], "plugin name")
    const reports = []
    for (const name of rest) {
      const ref = resolveRef(paths, name)
      const record = await installPlugin(paths, ref)
      reports.push({ ...buildReport(activeFor(formatId(ref))), installPath: record.installPath })
    }
    print(
      rest.length === 1 ? reports[0] : reports,
      reports.map((report) => `Installed ${formatReport(report)}`).join("\n"),
    )
    return 0
  }

  if (command === "uninstall") {
    const ref = resolveRef(paths, need(rest[0], "plugin name"))
    uninstallPlugin(paths, ref, { keepData: values["keep-data"] === true })
    print({ uninstalled: formatId(ref) }, `Uninstalled ${formatId(ref)}`)
    return 0
  }

  if (command === "enable" || command === "disable") {
    const ref = resolveRef(paths, need(rest[0], "plugin name"))
    setEnabled(paths, ref, command === "enable")
    print(
      { id: formatId(ref), enabled: command === "enable" },
      `${command === "enable" ? "Enabled" : "Disabled"} ${formatId(ref)}`,
    )
    return 0
  }

  if (command === "update") {
    // Refresh the marketplaces first, so a reinstall picks up what they now point at.
    const targets =
      rest.length > 0
        ? rest.map((name) => resolveRef(paths, name))
        : listInstalled(paths).map((item) => resolveRef(paths, item.id))
    for (const name of new Set(targets.map((ref) => ref.marketplace))) await updateMarketplace(paths, name)
    const rows = []
    for (const ref of targets) {
      const before = listInstalled(paths).find((item) => item.id === formatId(ref))?.record.version
      const record = await installPlugin(paths, ref)
      rows.push({ id: formatId(ref), from: before, to: record.version })
    }
    print(
      rows,
      rows
        .map((row) => `${row.id}\t${row.from === row.to ? `${row.to} (unchanged)` : `${row.from} -> ${row.to}`}`)
        .join("\n") || "No plugins installed",
    )
    return 0
  }

  if (command === "setup") {
    const result = registerWithOpencode()
    print(
      result,
      result.changed ? `Added ${result.plugin} to ${result.config}` : `${result.plugin} is already in ${result.config}`,
    )
    return 0
  }

  if (command === "doctor") {
    const checks = doctor(paths)
    print(checks, checks.map((check) => `${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`).join("\n"))
    return checks.every((check) => check.ok) ? 0 : 1
  }

  if (command === "list") {
    const rows = listInstalled(paths).map((item) => ({
      id: item.id,
      version: item.record.version,
      enabled: item.enabled,
    }))
    print(
      rows,
      rows.map((row) => `${row.id}\t${row.version}\t${row.enabled ? "enabled" : "disabled"}`).join("\n") ||
        "No plugins installed",
    )
    return 0
  }

  if (command === "inspect") {
    const target = need(rest[0], "plugin name or directory")
    const directory = path.resolve(target)
    const active = existsSync(directory)
      ? activeForDirectory(directory)
      : activeFor(formatId(resolveRef(paths, target)))
    const report = buildReport(active)
    print(report, formatReport(report))
    return report.issues.some((issue) => issue.level === "error") ? 1 : 0
  }

  throw new Error(`Unknown command: ${command}. Run c4o --help.`)

  function activeFor(id: string): ActivePlugin {
    const installed = listInstalled(paths).find((item) => item.id === id)
    if (!installed) throw new Error(`${id} is not installed`)
    // Inspect disabled plugins too: load straight from the record rather than the enabled set.
    const enabled = loadActivePlugins(paths).find((item) => item.id === id)
    if (enabled) return enabled
    const plugin = loadPlugin({
      root: installed.record.installPath,
      ...(installed.record.entry === undefined ? {} : { entry: installed.record.entry }),
      ...(installed.record.isMarketplaceRoot ? { entryIsMarketplaceRoot: true } : {}),
    })
    return { id, plugin, dataDir: dataDirectory(paths, id), options: {} }
  }

  function activeForDirectory(directory: string): ActivePlugin {
    const plugin = loadPlugin({ root: directory })
    const id = `${plugin.name}@inline`
    return { id, plugin, dataDir: dataDirectory(paths, id), options: {} }
  }
}

/** The directory opencode should load as a plugin: the one holding this build's `server` entry. */
function pluginDirectory() {
  return path.dirname(fileURLToPath(import.meta.url))
}

function opencodeConfigFile() {
  const directory = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? homedir(), ".config"),
    "opencode",
  )
  return (
    ["opencode.jsonc", "opencode.json"].map((name) => path.join(directory, name)).find((file) => existsSync(file)) ??
    path.join(directory, "opencode.jsonc")
  )
}

function configuredPlugins(file: string): string[] {
  if (!existsSync(file)) return []
  const plugins = (parseJsonc(readFileSync(file, "utf8")) as { plugins?: unknown } | undefined)?.plugins
  return Array.isArray(plugins)
    ? plugins.map((item) => (typeof item === "string" ? item : String((item as { package?: unknown }).package)))
    : []
}

/** Adds this build to the `plugins` list of opencode's global config, keeping comments and formatting. */
function registerWithOpencode() {
  const config = opencodeConfigFile()
  const plugin = pluginDirectory()
  if (configuredPlugins(config).includes(plugin)) return { config, plugin, changed: false }
  const text = existsSync(config) ? readFileSync(config, "utf8") : "{}\n"
  const edits = modify(text, ["plugins", -1], plugin, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  mkdirSync(path.dirname(config), { recursive: true })
  writeFileSync(config, applyEdits(text, edits))
  return { config, plugin, changed: true }
}

function doctor(paths: ReturnType<typeof storePaths>) {
  const version = (command: string) => {
    try {
      return execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim()
        .split("\n")[0]!
    } catch {
      return undefined
    }
  }
  const git = version("git")
  const opencode = version("opencode")
  const config = opencodeConfigFile()
  const registered = configuredPlugins(config).some(
    (item) => item === pluginDirectory() || /(^|\/)claude-4-opencode(@|$)/.test(item),
  )
  const installed = listInstalled(paths)
  const broken = loadActivePlugins(paths).flatMap((active) =>
    active.plugin.issues.filter((issue) => issue.level === "error").map((issue) => `${active.id}: ${issue.message}`),
  )
  return [
    { name: "git", ok: git !== undefined, detail: git ?? "not found; needed to add marketplaces and install plugins" },
    {
      name: "opencode",
      ok: opencode !== undefined && /\bv?2\./.test(opencode),
      detail:
        opencode === undefined
          ? "not found on PATH"
          : /\bv?2\./.test(opencode)
            ? opencode
            : `${opencode} (version 2 is required)`,
    },
    { name: "plugin registered", ok: registered, detail: registered ? config : `not in ${config}; run c4o setup` },
    {
      name: "store",
      ok: true,
      detail: `${paths.root} (${installed.length} installed, ${installed.filter((item) => item.enabled).length} enabled)`,
    },
    { name: "plugins load", ok: broken.length === 0, detail: broken.length === 0 ? "no errors" : broken.join("; ") },
  ]
}

function describeOrigin(origin: ReturnType<typeof parseMarketplaceInput>) {
  if (origin.source === "github") return `github:${origin.repo}${origin.ref ? `@${origin.ref}` : ""}`
  if (origin.source === "git") return `${origin.url}${origin.ref ? `#${origin.ref}` : ""}`
  if (origin.source === "url") return origin.url
  return origin.path
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`c4o: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
