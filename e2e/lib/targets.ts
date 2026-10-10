import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { fetchRepo, git } from "../../src/store/git.ts"
import { REPO } from "./repo.ts"

export interface Target {
  repo: string
  sha: string
}

const lock = JSON.parse(readFileSync(path.join(REPO, "e2e", "targets.lock.json"), "utf8")) as {
  marketplaces: Record<string, Target>
}

export function target(name: string): Target {
  const found = lock.marketplaces[name]
  if (!found) throw new Error(`No pinned target named ${name} in e2e/targets.lock.json`)
  return found
}

export const targetNames = Object.keys(lock.marketplaces)

/**
 * Returns a checkout of the marketplace at its pinned commit, cloning it from GitHub on first use.
 * Checkouts are keyed by SHA under `.e2e/cache`, so CI can cache the directory on the lock file.
 * Each one also serves as a local git mirror for sandboxes.
 */
export async function marketplaceCheckout(name: string): Promise<string> {
  const { repo, sha } = target(name)
  const directory = path.join(REPO, ".e2e", "cache", "marketplaces", `${name}@${sha.slice(0, 12)}`)
  if (existsSync(path.join(directory, ".claude-plugin", "marketplace.json"))) return directory
  mkdirSync(path.dirname(directory), { recursive: true })
  const staging = `${directory}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  await fetchRepo({ url: `https://github.com/${repo}.git`, destination: staging, sha })
  // Sandboxes clone from this checkout in place of GitHub, by commit.
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"], staging)
  // A plain `git clone` of the mirror needs a default branch to check out.
  await git(["checkout", "-q", "-B", "main"], staging)
  rmSync(directory, { recursive: true, force: true })
  renameSync(staging, directory)
  return directory
}

/** git config that redirects a marketplace's GitHub URLs to its cached checkout. */
export function mirrorConfig(repo: string, checkout: string) {
  const spellings = [`https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git`]
  return `[url "file://${checkout}"]\n${spellings.map((url) => `\tinsteadOf = ${url}\n`).join("")}`
}
