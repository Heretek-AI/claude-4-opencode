import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isRecord } from "../spec/frontmatter.ts"
import type { MarketplaceEntry } from "../spec/types.ts"
import type { StorePaths } from "./paths.ts"

export type MarketplaceOrigin =
  | { source: "github"; repo: string; ref?: string }
  | { source: "git"; url: string; ref?: string }
  | { source: "url"; url: string }
  | { source: "directory"; path: string }
  | { source: "file"; path: string }

export interface KnownMarketplace {
  source: MarketplaceOrigin
  /** Directory or marketplace.json path that `readMarketplace` accepts. */
  installLocation: string
  lastUpdated: string
  sha?: string
}

export interface InstalledRecord {
  scope: "user"
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
  /** Snapshot of the marketplace entry, which can supply or extend the plugin's manifest. */
  entry?: MarketplaceEntry
  isMarketplaceRoot?: boolean
}

export interface InstalledFile {
  version: 2
  plugins: Record<string, InstalledRecord[]>
}

export interface Settings {
  enabledPlugins: Record<string, boolean>
  /** Values for each plugin's `userConfig` options. */
  pluginConfigs: Record<string, { options: Record<string, unknown> }>
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, "utf8"))
}

/** Writes through a temporary file so a reader never sees a half-written state file. */
function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n")
  renameSync(temporary, file)
}

export function readKnownMarketplaces(paths: StorePaths): Record<string, KnownMarketplace> {
  const value = readJson(paths.knownMarketplaces)
  return isRecord(value) ? (value as Record<string, KnownMarketplace>) : {}
}

export function writeKnownMarketplaces(paths: StorePaths, value: Record<string, KnownMarketplace>) {
  writeJson(paths.knownMarketplaces, value)
}

export function readInstalled(paths: StorePaths): InstalledFile {
  const value = readJson(paths.installed)
  if (isRecord(value) && isRecord(value.plugins)) return value as unknown as InstalledFile
  return { version: 2, plugins: {} }
}

export function writeInstalled(paths: StorePaths, value: InstalledFile) {
  writeJson(paths.installed, value)
}

export function readSettings(paths: StorePaths): Settings {
  const value = readJson(paths.settings)
  return {
    enabledPlugins:
      isRecord(value) && isRecord(value.enabledPlugins) ? (value.enabledPlugins as Record<string, boolean>) : {},
    pluginConfigs:
      isRecord(value) && isRecord(value.pluginConfigs) ? (value.pluginConfigs as Settings["pluginConfigs"]) : {},
  }
}

export function writeSettings(paths: StorePaths, value: Settings) {
  writeJson(paths.settings, value)
}
