import { execFile } from "node:child_process"
import { mkdirSync } from "node:fs"

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

/** Shallow-fetches one commit into `destination` and returns its SHA. A `sha` wins over a `ref`. */
export async function fetchRepo(options: FetchOptions): Promise<string> {
  mkdirSync(options.destination, { recursive: true })
  const cwd = options.destination
  await git(["init", "-q"], cwd)
  await git(["remote", "add", "origin", options.url], cwd)
  if (options.subdir)
    await git(["sparse-checkout", "set", "--no-cone", `/${options.subdir.replace(/^\/+|\/+$/g, "")}/`], cwd)
  const target = options.sha ?? options.ref ?? "HEAD"
  await git(["fetch", "-q", "--depth", "1", ...(options.subdir ? ["--filter=blob:none"] : []), "origin", target], cwd)
  await git(["checkout", "-q", "FETCH_HEAD"], cwd)
  return git(["rev-parse", "HEAD"], cwd)
}
