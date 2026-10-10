/**
 * Rewrites e2e/targets.lock.json so every marketplace points at the current commit of its
 * default branch. Run by the drift workflow before recapturing goldens and running the suite.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { git } from "../src/store/git.ts"
import { REPO } from "./lib/repo.ts"

const file = path.join(REPO, "e2e", "targets.lock.json")
const lock = JSON.parse(readFileSync(file, "utf8")) as { marketplaces: Record<string, { repo: string; sha: string }> }
for (const [name, target] of Object.entries(lock.marketplaces)) {
  const head = (await git(["ls-remote", `https://github.com/${target.repo}.git`, "HEAD"])).split(/\s+/)[0]
  if (!head || !/^[0-9a-f]{40}$/.test(head)) throw new Error(`Could not resolve HEAD of ${target.repo}`)
  console.log(`${name}: ${target.sha.slice(0, 7)} -> ${head.slice(0, 7)}${head === target.sha ? " (unchanged)" : ""}`)
  target.sha = head
}
writeFileSync(file, JSON.stringify(lock, null, 2) + "\n")
