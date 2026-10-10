import { execFile } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"

export function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      // Never block on a credential prompt: a private or missing repository must fail, not hang.
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`))
        else resolve(stdout.trim())
      },
    )
  })
}

export interface FetchOptions {
  url: string
  destination: string
  ref?: string
  sha?: string
  /** Check out only this subdirectory. */
  subdir?: string
}

/** Refs/SHAs must be plain names or hashes, never git flags. */
const REF_PATTERN = /^[A-Za-z0-9._/+-]+$/

function assertSafeRef(value: string, label: string) {
  if (!REF_PATTERN.test(value) || value.startsWith("-") || value.startsWith("--"))
    throw new Error(`Invalid git ${label}: ${JSON.stringify(value)}`)
}

function assertSafeUrl(url: string) {
  const trimmed = url.trimStart()
  if (!trimmed || trimmed.startsWith("-") || /^ext::/i.test(trimmed))
    throw new Error(`Invalid git URL: ${JSON.stringify(url)}`)
}

/** Shallow-fetches one commit into `destination` and returns its SHA. A `sha` wins over a `ref`. */
export async function fetchRepo(options: FetchOptions): Promise<string> {
  assertSafeUrl(options.url)
  if (options.sha !== undefined) assertSafeRef(options.sha, "sha")
  if (options.ref !== undefined) assertSafeRef(options.ref, "ref")
  mkdirSync(options.destination, { recursive: true })
  const cwd = options.destination
  await git(["init", "-q"], cwd)
  await git(["remote", "add", "origin", options.url], cwd)
  if (options.subdir) {
    const raw = options.subdir
    const clean = raw.replace(/^\/+|\/+$/g, "")
    if (
      clean === "" ||
      clean === "." ||
      clean.startsWith("-") ||
      path.isAbsolute(raw) ||
      path.posix.isAbsolute(raw) ||
      path.win32.isAbsolute(raw) ||
      clean.includes("\\") ||
      clean.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    )
      throw new Error(`Refusing to sparse-checkout unsafe subdir: ${JSON.stringify(raw)}`)
    await git(["sparse-checkout", "set", "--no-cone", `/${clean}/`], cwd)
  }
  const target = options.sha ?? options.ref ?? "HEAD"
  await git(
    ["fetch", "-q", "--depth", "1", ...(options.subdir ? ["--filter=blob:none"] : []), "origin", "--", target],
    cwd,
  )
  await git(["checkout", "-q", "FETCH_HEAD"], cwd)
  return git(["rev-parse", "HEAD"], cwd)
}
