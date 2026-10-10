/**
 * Captures what real Claude Code exposes for each pinned marketplace, as golden files that
 * `e2e/golden.test.ts` compares our loader against.
 *
 *   bun e2e/oracle/capture.ts [marketplace-key ...]
 *
 * Claude Code runs in a throwaway config directory with a dummy API key, hooks disabled and
 * plugin MCP servers ignored, so nothing here touches your own Claude Code setup, runs plugin
 * code, or makes a model request. git is pointed at the cached checkout, so Claude Code adds
 * each marketplace "from GitHub" at exactly the pinned commit.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readMarketplace, resolveSource } from "../../src/spec/marketplace.ts"
import { git } from "../../src/store/git.ts"
import { REPO } from "../lib/repo.ts"
import { marketplaceCheckout, mirrorConfig, target, targetNames } from "../lib/targets.ts"

const CLAUDE = process.env.CLAUDE_BIN ?? "claude"

interface Golden {
  claudeCode: string
  repo: string
  sha: string
  /** Entries Claude Code refused to install, with its message. */
  failed: Record<string, string>
  plugins: Record<string, { commands: string[]; skills: string[]; agents: string[] }>
}

function run(args: string[], env: Record<string, string>, cwd: string, untilInit = false): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    const onData = (chunk: Buffer) => {
      output += chunk
      // The init event is all that is needed; stop before any model request is attempted.
      if (untilInit && /"subtype":"init".*\n/.test(output)) child.kill("SIGTERM")
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("close", () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
}

async function capture(key: string): Promise<Golden> {
  const { repo, sha } = target(key)
  const checkout = await marketplaceCheckout(key)
  const read = readMarketplace(checkout)
  const marketplace = read.marketplace!
  const root = mkdtempSync(path.join(tmpdir(), "c4o-oracle-"))
  try {
    const config = path.join(root, "config")
    const cwd = path.join(root, "cwd")
    mkdirSync(config, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(path.join(config, "settings.json"), JSON.stringify({ disableAllHooks: true }))
    writeFileSync(path.join(root, "gitconfig"), mirrorConfig(repo, checkout))
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      CLAUDE_CONFIG_DIR: config,
      GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
      ANTHROPIC_API_KEY: "sk-ant-oracle-dummy",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }
    mkdirSync(env.HOME, { recursive: true })

    const version = (await run(["--version"], env, cwd)).trim().split(/\s+/)[0] ?? "unknown"
    const added = await run(["plugin", "marketplace", "add", repo], env, cwd)
    if (!added.includes("Successfully added")) throw new Error(`Claude Code could not add ${repo}: ${added.trim()}`)
    const cloned = await git(
      ["rev-parse", "HEAD"],
      path.join(config, "plugins", "marketplaces", marketplace.name),
    ).catch(() => "")
    if (cloned !== sha)
      throw new Error(`Claude Code fetched ${cloned || "something else"} instead of the pinned ${sha}`)

    const failed: Record<string, string> = {}
    const entries = marketplace.plugins.filter(
      (entry) => resolveSource(entry.source, marketplace, read.root).kind === "local",
    )
    for (const [index, entry] of entries.entries()) {
      const output = await run(["plugin", "install", `${entry.name}@${marketplace.name}`], env, cwd)
      if (!output.includes("Successfully installed"))
        failed[entry.name] = output.trim().split("\n").at(-1)!.slice(0, 300)
      if ((index + 1) % 20 === 0) console.error(`  ${key}: installed ${index + 1}/${entries.length}`)
    }

    const stream = await run(
      ["-p", "hi", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"],
      env,
      cwd,
      true,
    )
    const line = stream.split("\n").find((item) => item.includes('"subtype":"init"'))
    if (!line) throw new Error(`Claude Code printed no init event for ${key}: ${stream.slice(0, 500)}`)
    const init = JSON.parse(line) as {
      slash_commands: string[]
      skills?: string[]
      agents: string[]
      plugins: { name: string }[]
    }

    // An id belongs to the plugin whose name is its longest `name:` prefix.
    const names = init.plugins.map((plugin) => plugin.name).toSorted((a, b) => b.length - a.length)
    const plugins: Golden["plugins"] = {}
    const assign = (kind: "commands" | "skills" | "agents", ids: string[]) => {
      for (const id of ids) {
        const owner = names.find((name) => id.startsWith(`${name}:`))
        if (!owner || owner.startsWith("cc-plugin-")) continue
        ;(plugins[owner] ??= { commands: [], skills: [], agents: [] })[kind].push(id)
      }
    }
    assign("commands", init.slash_commands)
    assign("skills", init.skills ?? [])
    assign("agents", init.agents)
    for (const plugin of Object.values(plugins)) for (const list of Object.values(plugin)) list.sort()
    return {
      claudeCode: version,
      repo,
      sha,
      failed,
      plugins: Object.fromEntries(Object.entries(plugins).toSorted(([a], [b]) => a.localeCompare(b))),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const keys = process.argv.slice(2).length > 0 ? process.argv.slice(2) : targetNames
for (const key of keys) {
  console.error(`Capturing ${key}...`)
  const golden = await capture(key)
  const file = path.join(REPO, "e2e", "golden", `${key}.json`)
  writeFileSync(file, JSON.stringify(golden, null, 2) + "\n")
  console.error(
    `  wrote ${path.relative(REPO, file)}: ${Object.keys(golden.plugins).length} plugins, ${Object.keys(golden.failed).length} failed installs`,
  )
}
