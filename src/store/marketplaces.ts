import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readMarketplace, type MarketplaceRead } from "../spec/marketplace.ts"
import { fetchRepo } from "./git.ts"
import type { StorePaths } from "./paths.ts"
import {
  readKnownMarketplaces,
  writeKnownMarketplaces,
  type KnownMarketplace,
  type MarketplaceOrigin,
} from "./state.ts"

/**
 * Accepts what `claude plugin marketplace add` accepts:
 * - a path to a marketplace directory or to its marketplace.json
 * - `owner/repo`, optionally `@ref` or `#ref`
 * - a git URL: `user@host:path`, or http(s) ending in `.git`, containing `/_git/`, or naming a
 *   github.com or gitlab.com repository. `#ref` pins a ref.
 * - any other http(s) URL, taken as a direct link to a marketplace.json file
 */
export function parseMarketplaceInput(input: string, cwd: string): MarketplaceOrigin {
  const local = path.resolve(cwd, input)
  if (existsSync(local))
    return statSync(local).isFile() ? { source: "file", path: local } : { source: "directory", path: local }
  const shorthand = /^([A-Za-z0-9][\w.-]*\/[\w.-]+?)(?:\.git)?(?:[@#]([\w./-]+))?$/.exec(input)
  if (shorthand) {
    const repo = shorthand[1]!
    const ref = shorthand[2]
    if (repo.includes(".."))
      throw new Error(
        `Not a marketplace source: ${input}. Use owner/repo, a git URL, a marketplace.json URL, or a local path.`,
      )
    if (ref !== undefined && ref.startsWith("-"))
      throw new Error(
        `Not a marketplace source: ${input}. Use owner/repo, a git URL, a marketplace.json URL, or a local path.`,
      )
    return { source: "github", repo, ...(ref ? { ref } : {}) }
  }
  const hash = input.lastIndexOf("#")
  const url = hash === -1 ? input : input.slice(0, hash)
  const ref = hash === -1 ? {} : { ref: input.slice(hash + 1) }
  {
    const trimmed = url.trimStart()
    if (trimmed.startsWith("-") || /^ext::/i.test(trimmed))
      throw new Error(
        `Not a marketplace source: ${input}. Use owner/repo, a git URL, a marketplace.json URL, or a local path.`,
      )
    if (typeof (ref as { ref?: string }).ref === "string" && (ref as { ref: string }).ref.startsWith("-"))
      throw new Error(
        `Not a marketplace source: ${input}. Use owner/repo, a git URL, a marketplace.json URL, or a local path.`,
      )
  }
  if (/^[\w.-]+@[\w.-]+:/.test(url) || /^(ssh|git|file):\/\//.test(url)) return { source: "git", url, ...ref }
  if (/^https?:\/\//.test(url)) {
    const isGit =
      /\.git$/.test(url) ||
      url.includes("/_git/") ||
      /^https?:\/\/(www\.)?(github|gitlab)\.com\/[^/]+\/[^/]+\/?$/.test(url)
    return isGit ? { source: "git", url, ...ref } : { source: "url", url: input }
  }
  throw new Error(
    `Not a marketplace source: ${input}. Use owner/repo, a git URL, a marketplace.json URL, or a local path.`,
  )
}

/** Names Claude Code reserves for Anthropic's own marketplaces, per the marketplace reference. */
const RESERVED_NAMES = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "life-sciences",
  "knowledge-work-plugins",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "claude-tag-plugins",
  "claude-community",
  "claude-plugins-community",
  "healthcare",
  "anthropic-plugin-directory",
  "claude-plugin-directory",
])

/**
 * Names no marketplace may use: the ones that label plugins which did not come from a
 * marketplace, package-manager names, and members every JavaScript object has. The last group
 * matters here too, because the store keys plain objects by marketplace name.
 */
const FORBIDDEN_NAMES = new Set([
  "inline",
  "builtin",
  "skills-dir",
  "synced",
  "claude-plugin-test",
  "npm",
  "pip",
  "uv",
  "cargo",
  "github",
  "gh",
  "constructor",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tolocalestring",
  "tostring",
  "valueof",
  "__proto__",
])

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit. Also what keeps store paths contained. */
const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidIdPart(name: string) {
  return ID_PART.test(name) && !name.includes("..")
}

/**
 * Applies Claude Code's marketplace naming rules. A reserved name is only accepted from the
 * anthropics GitHub organization, so another repository cannot pass itself off as official.
 */
export function assertNameAllowed(name: string, origin: MarketplaceOrigin) {
  if (!isValidIdPart(name))
    throw new Error(
      `Cannot use marketplace name "${name}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    )
  const lower = name.toLowerCase()
  if (FORBIDDEN_NAMES.has(lower) || lower.startsWith("claudeai-"))
    throw new Error(`The marketplace name "${name}" is reserved and cannot be registered.`)
  const official =
    (origin.source === "github" && /^anthropics\//i.test(origin.repo)) ||
    (origin.source === "git" && /^(https:\/\/github\.com\/|git@github\.com:)anthropics\//i.test(origin.url))
  if (official) return
  // Another spelling of a reserved name counts as that name: `claude.code.plugins`.
  const normalized = lower.replace(/\.$/, "").replace(/[^a-z0-9_]+/g, "-")
  if (RESERVED_NAMES.has(normalized))
    throw new Error(
      `The marketplace name '${name}' is reserved for official Anthropic marketplaces and is only accepted from the anthropics GitHub organization.`,
    )
  if (/official/.test(lower) && /claude|anthropic/.test(lower))
    throw new Error(`Marketplace name "${name}" impersonates an official Anthropic/Claude marketplace.`)
}

export interface AddResult {
  name: string
  known: KnownMarketplace
  read: MarketplaceRead
}

/**
 * Whether two origins identify the same marketplace. Refs are versions, not identity: the same
 * repository at a different ref still counts as the same marketplace, so re-adding with a new
 * ref (or updating) is allowed while a different repository under the same name is rejected.
 */
export function sameOrigin(a: MarketplaceOrigin, b: MarketplaceOrigin): boolean {
  if (a.source !== b.source) return false
  if (a.source === "github" && b.source === "github") return a.repo === b.repo
  if (a.source === "git" && b.source === "git") return a.url === b.url
  if (a.source === "url" && b.source === "url") return a.url === b.url
  if (a.source === "directory" && b.source === "directory") return a.path === b.path
  if (a.source === "file" && b.source === "file") return a.path === b.path
  return false
}

function describeOrigin(origin: MarketplaceOrigin): string {
  if (origin.source === "github") return `github:${origin.repo}${origin.ref ? `@${origin.ref}` : ""}`
  if (origin.source === "git") return `${origin.url}${origin.ref ? `#${origin.ref}` : ""}`
  if (origin.source === "url") return origin.url
  return origin.path
}

/**
 * Rejects a fresh `add` that would take over an existing registration from somewhere else.
 * Re-adding the same origin (or updating the entry being updated) is allowed.
 */
function assertNameFree(paths: StorePaths, name: string, origin: MarketplaceOrigin, expectedName: string | undefined) {
  const existing = readKnownMarketplaces(paths)[name]
  if (!existing) return
  if (expectedName !== undefined && name === expectedName) return
  if (sameOrigin(existing.source, origin)) return
  throw new Error(
    `Marketplace name "${name}" is already registered from a different source (${describeOrigin(existing.source)}). Remove it first before registering ${describeOrigin(origin)} under the same name.`,
  )
}

/**
 * Guards the `rmSync(destination)` before a clone is moved into place: if the destination
 * directory already belongs to a different registered marketplace, refuse to delete it.
 */
function assertDestinationFree(paths: StorePaths, name: string, destination: string) {
  if (!existsSync(destination)) return
  for (const [other, known] of Object.entries(readKnownMarketplaces(paths))) {
    if (other !== name && known.installLocation === destination)
      throw new Error(
        `Cannot install marketplace "${name}" to ${destination}: it belongs to marketplace "${other}". Remove "${other}" first.`,
      )
  }
}

function assertNoRename(expected: string | undefined, actual: string) {
  if (expected !== undefined && actual !== expected)
    throw new Error(`marketplace renamed from "${expected}" to "${actual}", remove and re-add instead of updating`)
}

export async function addMarketplace(
  paths: StorePaths,
  origin: MarketplaceOrigin,
  options: { expectedName?: string } = {},
): Promise<AddResult> {
  const expected = options.expectedName
  if (origin.source === "directory" || origin.source === "file") {
    // Local marketplaces are used in place, so edits to them show up without a re-add.
    const read = requireMarketplace(readMarketplace(origin.path))
    const name = read.marketplace!.name
    assertNameAllowed(name, origin)
    assertNoRename(expected, name)
    assertNameFree(paths, name, origin, expected)
    return register(paths, read, {
      source: origin,
      installLocation: origin.path,
      lastUpdated: new Date().toISOString(),
    })
  }
  mkdirSync(paths.marketplaces, { recursive: true })
  const staging = path.join(paths.marketplaces, `.staging-${process.pid}-${Date.now()}`)
  try {
    const sha =
      origin.source === "url" ? await downloadManifest(origin.url, staging) : await cloneMarketplace(origin, staging)
    const name = requireMarketplace(readMarketplace(staging)).marketplace!.name
    assertNameAllowed(name, origin)
    assertNoRename(expected, name)
    assertNameFree(paths, name, origin, expected)
    const destination = path.join(paths.marketplaces, name)
    assertDestinationFree(paths, name, destination)
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
    return register(paths, requireMarketplace(readMarketplace(destination)), {
      source: origin,
      installLocation: destination,
      lastUpdated: new Date().toISOString(),
      ...(sha === undefined ? {} : { sha }),
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function cloneMarketplace(origin: Extract<MarketplaceOrigin, { source: "github" | "git" }>, destination: string) {
  const url = origin.source === "github" ? `https://github.com/${origin.repo}.git` : origin.url
  return fetchRepo({ url, destination, ...(origin.ref === undefined ? {} : { ref: origin.ref }) })
}

/**
 * A `url` marketplace is only the manifest file. Its plugins must use object sources, because
 * there is no repository for relative paths to resolve against.
 */
async function downloadManifest(url: string, destination: string): Promise<undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`)
  mkdirSync(path.join(destination, ".claude-plugin"), { recursive: true })
  writeFileSync(path.join(destination, ".claude-plugin", "marketplace.json"), await response.text())
  return undefined
}

function requireMarketplace(read: MarketplaceRead): MarketplaceRead {
  if (read.marketplace) return read
  throw new Error(read.issues.map((issue) => issue.message).join("; ") || "Not a marketplace")
}

function register(paths: StorePaths, read: MarketplaceRead, known: KnownMarketplace): AddResult {
  const name = read.marketplace!.name
  writeKnownMarketplaces(paths, { ...readKnownMarketplaces(paths), [name]: known })
  return { name, known, read }
}

/** Re-fetches a git-backed marketplace. Local ones are always current. */
export function updateMarketplace(paths: StorePaths, name: string): Promise<AddResult> {
  const known = readKnownMarketplaces(paths)[name]
  if (!known) throw new Error(`Unknown marketplace: ${name}`)
  return addMarketplace(paths, known.source, { expectedName: name })
}

export function removeMarketplace(paths: StorePaths, name: string) {
  const all = readKnownMarketplaces(paths)
  const known = all[name]
  if (!known) throw new Error(`Unknown marketplace: ${name}`)
  if (known.source.source !== "directory" && known.source.source !== "file")
    rmSync(known.installLocation, { recursive: true, force: true })
  delete all[name]
  writeKnownMarketplaces(paths, all)
}

export function loadKnownMarketplace(
  paths: StorePaths,
  name: string,
): { known: KnownMarketplace; read: MarketplaceRead } {
  const known = readKnownMarketplaces(paths)[name]
  if (!known) throw new Error(`Unknown marketplace: ${name}. Add it with: c4o marketplace add <source>`)
  return { known, read: requireMarketplace(readMarketplace(known.installLocation)) }
}
