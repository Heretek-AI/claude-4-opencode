import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { asString, isRecord } from "./frontmatter.ts"
import type { Issue, Marketplace, MarketplaceEntry, PluginSource } from "./types.ts"

export interface MarketplaceRead {
  marketplace?: Marketplace
  /** Directory that relative plugin sources resolve against. */
  root: string
  issues: Issue[]
}

/** Reads a marketplace from its repository root, or from a direct path to marketplace.json. */
export function readMarketplace(target: string): MarketplaceRead {
  const resolved = path.resolve(target)
  const isFile = existsSync(resolved) && statSync(resolved).isFile()
  const file = isFile ? resolved : path.join(resolved, ".claude-plugin", "marketplace.json")
  // marketplace.json lives in .claude-plugin/, so its sources resolve two levels up.
  const root = isFile ? path.resolve(path.dirname(resolved), "..") : resolved
  const issues: Issue[] = []
  if (!existsSync(file)) {
    issues.push({ level: "error", message: "No .claude-plugin/marketplace.json found", path: file })
    return { root, issues }
  }
  const value = parseJson(file, issues)
  if (!isRecord(value)) return { root, issues }
  const name = asString(value.name)
  if (name === undefined) {
    issues.push({ level: "error", message: "Marketplace has no name", path: file })
    return { root, issues }
  }
  const plugins = (Array.isArray(value.plugins) ? value.plugins : []).flatMap((item, index): MarketplaceEntry[] => {
    if (!isRecord(item) || asString(item.name) === undefined || item.source === undefined) {
      issues.push({ level: "error", message: `plugins[${index}] needs a name and a source`, path: file })
      return []
    }
    return [item as MarketplaceEntry]
  })
  return {
    marketplace: {
      name,
      ...(isRecord(value.owner) ? { owner: value.owner } : {}),
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      plugins,
    },
    root,
    issues,
  }
}

function parseJson(file: string, issues: Issue[]): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    issues.push({ level: "error", message: `Invalid JSON: ${(error as Error).message}`, path: file })
    return undefined
  }
}

export type ResolvedSource =
  | { kind: "local"; directory: string; isMarketplaceRoot: boolean }
  | { kind: "git"; url: string; ref?: string; sha?: string; subdir?: string }
  | { kind: "npm"; package: string; version?: string; registry?: string }
  | { kind: "unsupported"; reason: string }

/** Turns an entry's `source` into something the installer can fetch. */
export function resolveSource(source: PluginSource, marketplace: Marketplace, root: string): ResolvedSource {
  if (typeof source === "string") {
    // Paths that do not start with ./ are relative to metadata.pluginRoot.
    const base =
      source.startsWith("./") || source === "." ? root : path.resolve(root, marketplace.metadata?.pluginRoot ?? ".")
    const directory = path.resolve(base, source)
    const offset = path.relative(root, directory)
    if (offset.startsWith("..") || path.isAbsolute(offset))
      return { kind: "unsupported", reason: `source path escapes the marketplace: ${source}` }
    return { kind: "local", directory, isMarketplaceRoot: directory === root }
  }
  const ref = asString(source.ref)
  const sha = asString(source.sha)
  const pin = { ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) }
  if (source.source === "github") {
    const repo = asString(source.repo)
    if (repo === undefined) return { kind: "unsupported", reason: "github source has no repo" }
    return { kind: "git", url: `https://github.com/${repo}.git`, ...pin }
  }
  if (source.source === "url" || source.source === "git") {
    const url = asString(source.url)
    if (url === undefined) return { kind: "unsupported", reason: "git source has no url" }
    return { kind: "git", url, ...pin }
  }
  if (source.source === "git-subdir") {
    const url = asString(source.url)
    const subdir = asString(source.path)
    if (url === undefined || subdir === undefined)
      return { kind: "unsupported", reason: "git-subdir source needs url and path" }
    return { kind: "git", url: gitUrl(url), subdir, ...pin }
  }
  if (source.source === "npm") {
    const name = asString(source.package)
    if (name === undefined) return { kind: "unsupported", reason: "npm source has no package" }
    const version = asString(source.version)
    const registry = asString(source.registry)
    return {
      kind: "npm",
      package: name,
      ...(version === undefined ? {} : { version }),
      ...(registry === undefined ? {} : { registry }),
    }
  }
  return { kind: "unsupported", reason: `source type "${String(source.source)}" is not supported` }
}

/** git-subdir accepts `owner/repo` shorthand as well as full URLs. */
function gitUrl(value: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}.git` : value
}
