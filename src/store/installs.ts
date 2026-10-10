import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { resolveSource } from "../spec/marketplace.ts"
import { loadPlugin, readManifest } from "../spec/plugin.ts"
import { asString } from "../spec/frontmatter.ts"
import { debug } from "../runtime/debug.ts"
import type { LoadedPlugin, MarketplaceEntry } from "../spec/types.ts"
import { fetchRepo } from "./git.ts"
import { isValidIdPart, loadKnownMarketplace } from "./marketplaces.ts"
import { dataDirectory, type StorePaths } from "./paths.ts"
import {
  readInstalled,
  readKnownMarketplaces,
  readSettings,
  writeInstalled,
  writeSettings,
  type InstalledRecord,
} from "./state.ts"

export interface PluginRef {
  plugin: string
  marketplace: string
}

export function formatId(ref: PluginRef) {
  return `${ref.plugin}@${ref.marketplace}`
}

/** Resolves `plugin@marketplace`, or a bare plugin name that exactly one known marketplace lists. */
export function resolveRef(paths: StorePaths, input: string): PluginRef {
  const at = input.lastIndexOf("@")
  if (at > 0) return { plugin: input.slice(0, at), marketplace: input.slice(at + 1) }
  const matches = Object.keys(readKnownMarketplaces(paths)).filter((name) =>
    loadKnownMarketplace(paths, name).read.marketplace!.plugins.some((entry) => entry.name === input),
  )
  if (matches.length === 1) return { plugin: input, marketplace: matches[0]! }
  if (matches.length === 0) throw new Error(`No known marketplace lists a plugin named ${input}`)
  throw new Error(`${input} is in several marketplaces (${matches.join(", ")}). Use ${input}@<marketplace>.`)
}

export async function installPlugin(paths: StorePaths, ref: PluginRef): Promise<InstalledRecord> {
  const { known, read } = loadKnownMarketplace(paths, ref.marketplace)
  const marketplace = read.marketplace!
  const entry = marketplace.plugins.find((item) => item.name === ref.plugin)
  if (!entry) throw new Error(`Marketplace ${ref.marketplace} has no plugin named ${ref.plugin}`)
  // The name becomes a directory in the cache, so it must not be able to leave it.
  if (!isValidIdPart(ref.plugin))
    throw new Error(
      `Cannot install plugin "${ref.plugin}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    )
  if (typeof entry.source === "string" && known.source.source === "url")
    throw new Error(
      `Cannot install ${formatId(ref)}: a marketplace added by URL has no files for the relative source ${entry.source}`,
    )
  const source = resolveSource(entry.source, marketplace, read.root)
  if (source.kind === "unsupported") throw new Error(`Cannot install ${formatId(ref)}: ${source.reason}`)
  if (source.kind === "npm")
    throw new Error(`Cannot install ${formatId(ref)}: npm plugin sources are not supported yet`)

  const now = new Date().toISOString()
  const inPlace = source.kind === "local" && (known.source.source === "directory" || known.source.source === "file")
  let record: InstalledRecord
  if (inPlace && source.kind === "local") {
    if (!existsSync(source.directory)) throw new Error(`Plugin source not found: ${source.directory}`)
    record = {
      scope: "user",
      installPath: source.directory,
      version: versionOf(source.directory, entry, undefined),
      installedAt: now,
      lastUpdated: now,
      entry,
      ...(source.isMarketplaceRoot ? { isMarketplaceRoot: true } : {}),
    }
  } else {
    const base = path.join(paths.cache, ref.marketplace, ref.plugin)
    mkdirSync(base, { recursive: true })
    const staging = mkdtempSync(path.join(base, ".staging-"))
    try {
      let sha = known.sha
      let content = staging
      if (source.kind === "local") {
        if (!existsSync(source.directory)) throw new Error(`Plugin source not found: ${source.directory}`)
        cpSync(source.directory, staging, { recursive: true, filter: (item) => path.basename(item) !== ".git" })
      } else {
        sha = await fetchRepo({ ...source, destination: staging })
        if (source.subdir) {
          if (path.isAbsolute(source.subdir))
            throw new Error(`Repository ${source.url} has an absolute directory ${source.subdir}`)
          content = path.join(staging, source.subdir)
          const offset = path.relative(staging, content)
          if (offset === "" || isEscapeOffset(offset))
            throw new Error(`Repository ${source.url} has a directory that escapes the checkout: ${source.subdir}`)
        }
        if (!existsSync(content)) throw new Error(`Repository ${source.url} has no directory ${source.subdir}`)
      }
      let version = versionOf(content, entry, sha)
      let installPath = path.join(base, version)
      // versionOf sanitizes, but never let a crafted version delete outside the plugin cache.
      if (isOutsideOrSame(base, installPath)) {
        version = sha?.slice(0, 12) ?? "unknown"
        installPath = path.join(base, version)
        if (isOutsideOrSame(base, installPath))
          throw new Error(`Refusing to install ${formatId(ref)}: unsafe version ${JSON.stringify(version)}`)
      }
      rmSync(installPath, { recursive: true, force: true })
      if (content === staging) renameSync(staging, installPath)
      else cpSync(content, installPath, { recursive: true })
      rmSync(path.join(installPath, ".git"), { recursive: true, force: true })
      record = {
        scope: "user",
        installPath,
        version,
        installedAt: now,
        lastUpdated: now,
        ...(sha === undefined ? {} : { gitCommitSha: sha }),
        entry,
        ...(source.kind === "local" && source.isMarketplaceRoot ? { isMarketplaceRoot: true } : {}),
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  const id = formatId(ref)
  const installed = readInstalled(paths)
  const previous = installed.plugins[id]?.[0]
  installed.plugins[id] = [{ ...record, installedAt: previous?.installedAt ?? record.installedAt }]
  writeInstalled(paths, installed)
  const settings = readSettings(paths)
  // An existing choice survives reinstalls and updates, as it does in Claude Code.
  if (settings.enabledPlugins[id] === undefined) {
    const manifest = readManifest(record.installPath, [])
    settings.enabledPlugins[id] = (entry.defaultEnabled ?? manifest?.defaultEnabled) !== false
    writeSettings(paths, settings)
  }
  return record
}

/** Manifest version wins over the entry's; without either, the commit identifies the version. */
function versionOf(directory: string, entry: MarketplaceEntry, sha: string | undefined) {
  const raw =
    asString(readManifest(directory, [])?.version) ?? asString(entry.version) ?? sha?.slice(0, 12) ?? "unknown"
  const version = raw.replace(/[^A-Za-z0-9._+-]/g, "-")
  // `.` and `..` would make path.join(base, version) delete the plugin dir or marketplace dir.
  if (
    version === "" ||
    version === "." ||
    version === ".." ||
    path.isAbsolute(version) ||
    version.includes("/") ||
    version.includes("\\")
  )
    return sha?.slice(0, 12) ?? "unknown"
  return version
}

export function uninstallPlugin(paths: StorePaths, ref: PluginRef, options: { keepData?: boolean } = {}) {
  const id = formatId(ref)
  const installed = readInstalled(paths)
  const records = installed.plugins[id]
  if (!records) throw new Error(`${id} is not installed`)
  for (const record of records) {
    // Only delete what the store owns. In-place installs point at the user's own directory.
    if (isInside(paths.cache, record.installPath)) rmSync(record.installPath, { recursive: true, force: true })
  }
  delete installed.plugins[id]
  writeInstalled(paths, installed)
  const settings = readSettings(paths)
  delete settings.enabledPlugins[id]
  delete settings.pluginConfigs[id]
  writeSettings(paths, settings)
  if (!options.keepData) rmSync(dataDirectory(paths, id), { recursive: true, force: true })
}

function isInside(parent: string, child: string) {
  const offset = path.relative(parent, child)
  return offset !== "" && !offset.startsWith("..") && !path.isAbsolute(offset)
}

/** True when joining an untrusted segment escapes `parent` (or collapses onto it). */
function isOutsideOrSame(parent: string, child: string) {
  const offset = path.relative(parent, child)
  return offset === "" || isEscapeOffset(offset)
}

/** `...` lives inside its parent; only `..` and `../...` escape. */
function isEscapeOffset(offset: string) {
  return (
    offset === ".." ||
    offset.startsWith(`..${path.sep}`) ||
    offset.startsWith("../") ||
    offset.startsWith("..\\") ||
    path.isAbsolute(offset)
  )
}

export function setEnabled(paths: StorePaths, ref: PluginRef, enabled: boolean) {
  const id = formatId(ref)
  if (!readInstalled(paths).plugins[id]) throw new Error(`${id} is not installed`)
  const settings = readSettings(paths)
  settings.enabledPlugins[id] = enabled
  writeSettings(paths, settings)
}

export interface InstalledPlugin {
  id: string
  record: InstalledRecord
  enabled: boolean
}

export function listInstalled(paths: StorePaths): InstalledPlugin[] {
  const settings = readSettings(paths)
  return Object.entries(readInstalled(paths).plugins).flatMap(([id, records]) =>
    records[0] ? [{ id, record: records[0], enabled: settings.enabledPlugins[id] !== false }] : [],
  )
}

/** A plugin the runtime should serve: loaded from disk, with the paths and options its variables resolve to. */
export interface ActivePlugin {
  id: string
  plugin: LoadedPlugin
  dataDir: string
  options: Record<string, unknown>
}

export interface ActiveOptions {
  /** Extra plugin directories to load directly, like `claude --plugin-dir`. */
  pluginDirs?: readonly string[]
}

export function loadActivePlugins(paths: StorePaths, options: ActiveOptions = {}): ActivePlugin[] {
  const settings = readSettings(paths)
  const fromStore: ActivePlugin[] = []
  for (const item of listInstalled(paths).filter((item) => item.enabled && existsSync(item.record.installPath))) {
    try {
      fromStore.push({
        id: item.id,
        plugin: loadPlugin({
          root: item.record.installPath,
          ...(item.record.entry === undefined ? {} : { entry: item.record.entry }),
          ...(item.record.isMarketplaceRoot ? { entryIsMarketplaceRoot: true } : {}),
        }),
        dataDir: dataDirectory(paths, item.id),
        options: settings.pluginConfigs[item.id]?.options ?? {},
      })
    } catch (error) {
      debug("loadActivePlugins failed", { id: item.id, error: String(error) })
    }
  }
  const fromDirs: ActivePlugin[] = []
  for (const directory of (options.pluginDirs ?? []).filter((directory) => existsSync(directory))) {
    try {
      const plugin = loadPlugin({ root: directory })
      const id = `${plugin.name}@inline`
      fromDirs.push({
        id,
        plugin,
        dataDir: dataDirectory(paths, id),
        options: settings.pluginConfigs[id]?.options ?? {},
      })
    } catch (error) {
      debug("loadActivePlugins failed", { directory, error: String(error) })
    }
  }
  // A directory passed explicitly overrides an installed plugin of the same name.
  const names = new Set(fromDirs.map((item) => item.plugin.name))
  return [...fromStore.filter((item) => !names.has(item.plugin.name)), ...fromDirs]
}
