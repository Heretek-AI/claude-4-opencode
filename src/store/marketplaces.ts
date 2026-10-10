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
  if (shorthand) return { source: "github", repo: shorthand[1]!, ...(shorthand[2] ? { ref: shorthand[2] } : {}) }
  const hash = input.lastIndexOf("#")
  const url = hash === -1 ? input : input.slice(0, hash)
  const ref = hash === -1 ? {} : { ref: input.slice(hash + 1) }
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

export async function addMarketplace(paths: StorePaths, origin: MarketplaceOrigin): Promise<AddResult> {
  if (origin.source === "directory" || origin.source === "file") {
    // Local marketplaces are used in place, so edits to them show up without a re-add.
    const read = requireMarketplace(readMarketplace(origin.path))
    assertNameAllowed(read.marketplace!.name, origin)
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
    const destination = path.join(paths.marketplaces, name)
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
  return addMarketplace(paths, known.source)
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
