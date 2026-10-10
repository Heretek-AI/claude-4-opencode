import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { REPO } from "./repo.ts"
import { startStub, type Recorded, type Step, type Stub } from "./stub-llm.ts"
import { marketplaceCheckout, mirrorConfig, target } from "./targets.ts"

export { REPO }
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode"

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface SandboxOptions {
  /** Scripted model replies, consumed in order by agent-loop requests. */
  script?: Step[]
  /** Options passed to the claude-4-opencode plugin through opencode's config. */
  pluginOptions?: Record<string, unknown>
  /** Leave the plugin out of opencode's config, for tests that register it with `c4o setup`. */
  unregistered?: boolean
  /** Use a real model instead of the stub, as `provider/model`. The stub still runs but sees no traffic. */
  liveModel?: string
  /** Extra environment for opencode, such as the live tier's API key. */
  env?: Record<string, string>
}

/**
 * A throwaway opencode installation: its own HOME and XDG directories, its own plugin store,
 * a project directory, and a stub model. Nothing in it touches the developer's real setup.
 */
export class Sandbox {
  readonly root: string
  readonly project: string
  readonly env: Record<string, string>
  readonly stub: Stub
  /** The live script. Steps pushed here are served to later agent-loop requests. */
  readonly script: Step[]
  readonly logFile: string
  private servers: Server[] = []

  constructor(options: SandboxOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "c4o-e2e-"))
    this.project = path.join(this.root, "project")
    this.logFile = path.join(this.root, "c4o.log")
    this.script = options.script ?? []
    this.stub = startStub(this.script)
    const config = path.join(this.root, "config", "opencode")
    for (const directory of [this.project, config, "home", "data", "cache", "state"])
      mkdirSync(path.isAbsolute(directory) ? directory : path.join(this.root, directory), { recursive: true })
    writeFileSync(path.join(this.project, "README.md"), "# Sandbox project\n")
    this.env = {
      PATH: process.env.PATH ?? "",
      TERM: "dumb",
      HOME: path.join(this.root, "home"),
      XDG_CONFIG_HOME: path.join(this.root, "config"),
      XDG_DATA_HOME: path.join(this.root, "data"),
      XDG_CACHE_HOME: path.join(this.root, "cache"),
      XDG_STATE_HOME: path.join(this.root, "state"),
      C4O_HOME: path.join(this.root, "data", "opencode", "claude-plugins"),
      C4O_LOG: this.logFile,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PASSWORD: "sandbox",
      GIT_CONFIG_GLOBAL: path.join(this.root, "gitconfig"),
      ...options.env,
    }
    writeFileSync(
      path.join(config, "opencode.jsonc"),
      JSON.stringify(
        {
          model: options.liveModel ?? "stub/scripted",
          update: "disable",
          share: "disabled",
          // The built bundle, loaded the way a user would load a plugin directory.
          ...(options.unregistered
            ? {}
            : { plugins: [{ package: path.join(REPO, "dist"), options: options.pluginOptions ?? {} }] }),
          providers: {
            stub: {
              name: "Stub",
              package: "@ai-sdk/openai-compatible",
              settings: { baseURL: this.stub.url, apiKey: "stub" },
              models: {
                scripted: {
                  name: "Scripted",
                  capabilities: { tools: true },
                  limit: { context: 200_000, output: 8_000 },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    )
    writeFileSync(this.env.GIT_CONFIG_GLOBAL!, "")
    execFileSync("git", ["init", "-q", this.project], { env: this.env })
  }

  private exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? this.project,
        env: this.env,
        // opencode run reads piped stdin as part of the prompt, so it must see EOF immediately.
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000)
      child.on("error", reject)
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  /** Runs the built `c4o` CLI against this sandbox's store. Throws on a non-zero exit. */
  async c4o(...args: string[]): Promise<ProcessResult> {
    const result = await this.exec("node", [path.join(REPO, "dist", "cli.js"), ...args])
    if (result.code !== 0)
      throw new Error(`c4o ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`)
    return result
  }

  /**
   * Adds a pinned marketplace the way a user would, as `owner/repo@sha`. git is pointed at the
   * cached checkout instead of GitHub, so the real clone path runs without the network.
   */
  async addMarketplace(name: string): Promise<string> {
    const { repo, sha } = target(name)
    const checkout = await marketplaceCheckout(name)
    appendFileSync(this.env.GIT_CONFIG_GLOBAL!, mirrorConfig(repo, checkout))
    await this.c4o("marketplace", "add", `${repo}@${sha}`)
    return checkout
  }

  /** Like `c4o`, parsing `--json` output. */
  async c4oJson<Result = unknown>(...args: string[]): Promise<Result> {
    return JSON.parse((await this.c4o(...args, "--json")).stdout) as Result
  }

  /** One headless turn through `opencode run`, with a private server. Returns the JSON event stream. */
  async run(
    message: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ code: number; events: RunEvent[]; stderr: string }> {
    const result = await this.exec(OPENCODE, ["run", "--standalone", "--auto", "--format", "json", message], options)
    const events = result.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as RunEvent)
    return { code: result.code, events, stderr: result.stderr }
  }

  /** Starts `opencode serve` for tests that need the HTTP API. */
  async serve(): Promise<Server> {
    const child = spawn(OPENCODE, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: this.project,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start:\n${output}`)), 60_000)
      const onData = (chunk: Buffer) => {
        output += chunk
        const match = /server listening on (\S+)/.exec(output)
        if (!match) return
        clearTimeout(timer)
        resolve(match[1]!)
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      child.on("close", (code) => reject(new Error(`opencode serve exited ${code}:\n${output}`)))
    })
    const server = new Server(url, this.project, child)
    this.servers.push(server)
    return server
  }

  /**
   * Queues model replies, performs `send` (a prompt or a command), and returns the agent-loop
   * requests it produced once the session is idle again.
   */
  async turn(
    server: Server,
    sessionID: string,
    steps: Step[],
    send: () => Promise<{ status: number; json: unknown }>,
  ): Promise<Recorded[]> {
    const before = this.stub.primary().length
    this.script.push(...steps)
    const response = await send()
    if (response.status >= 300)
      throw new Error(`Request failed with ${response.status}: ${JSON.stringify(response.json)}`)
    await this.stub.waitForPrimary(before + steps.length)
    await server.waitIdle(sessionID)
    return this.stub.primary().slice(before)
  }

  async dispose() {
    for (const server of this.servers) await server.stop()
    this.stub.stop()
    if (!process.env.C4O_E2E_KEEP) rmSync(this.root, { recursive: true, force: true })
  }

  async [Symbol.asyncDispose]() {
    await this.dispose()
  }
}

export interface RunEvent {
  type: string
  sessionID?: string
  part?: {
    type?: string
    tool?: string
    text?: string
    state?: { status?: string; input?: unknown; output?: unknown; error?: unknown }
  }
  error?: unknown
}

export interface Inventory {
  skills: string[]
  commands: string[]
  agents: string[]
  mcp: string[]
}

/** A running `opencode serve`, addressed for one project directory. */
export class Server {
  constructor(
    readonly url: string,
    private readonly directory: string,
    private readonly child: ChildProcess,
  ) {}

  async api<Result = unknown>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; json: Result }> {
    const target = new URL(route, this.url)
    if (method === "GET") target.searchParams.set("location[directory]", this.directory)
    const response = await fetch(target, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from("opencode:sandbox").toString("base64"),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const raw = await response.text()
    return { status: response.status, json: (raw === "" ? undefined : safeJson(raw)) as Result }
  }

  private async names(route: string, key: string): Promise<string[]> {
    const { json } = await this.api<unknown>("GET", route)
    const items = rows(json)
    return items.map((item) => String((item as Record<string, unknown>)[key])).toSorted()
  }

  async inventory(): Promise<Inventory> {
    const [skills, commands, agents, mcp] = await Promise.all([
      this.names("/api/skill", "id"),
      this.names("/api/command", "name"),
      this.names("/api/agent", "id"),
      this.api<unknown>("GET", "/api/mcp").then(({ json }) => mcpNames(json)),
    ])
    return { skills, commands, agents, mcp }
  }

  /**
   * Plugins activate after the location boots, so the first inventory can predate them.
   * Polls until `ready` accepts the inventory.
   */
  async waitForInventory(ready: (inventory: Inventory) => boolean, timeoutMs = 60_000): Promise<Inventory> {
    const deadline = Date.now() + timeoutMs
    let latest = await this.inventory()
    while (!ready(latest)) {
      if (Date.now() > deadline) throw new Error(`Inventory never became ready: ${JSON.stringify(latest)}`)
      await Bun.sleep(200)
      latest = await this.inventory()
    }
    return latest
  }

  async createSession(): Promise<string> {
    const { status, json } = await this.api<{ data: { id: string } }>("POST", "/api/session", {
      location: { directory: this.directory },
    })
    if (status !== 200) throw new Error(`session.create failed: ${status} ${JSON.stringify(json)}`)
    return json.data.id
  }

  prompt(sessionID: string, text: string) {
    return this.api("POST", `/api/session/${sessionID}/prompt`, { text })
  }

  /** Runs a slash command: `name` without the leading slash, `text` as its arguments. */
  command(sessionID: string, name: string, text = "") {
    return this.api("POST", `/api/session/${sessionID}/command`, { name, text })
  }

  /** Blocks until the session has no execution in flight. */
  waitIdle(sessionID: string) {
    return this.api("POST", `/api/experimental/session/${sessionID}/wait`, {})
  }

  async stop() {
    if (this.child.exitCode !== null) return
    const closed = new Promise((resolve) => this.child.once("close", resolve))
    this.child.kill("SIGTERM")
    await Promise.race([closed, Bun.sleep(5_000).then(() => this.child.kill("SIGKILL"))])
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** List endpoints answer either a bare array or `{ data: [...] }`. */
function rows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  const data = (json as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? data : []
}

function mcpNames(json: unknown): string[] {
  const data = (json as { data?: unknown } | undefined)?.data ?? json
  if (Array.isArray(data)) return data.map((item) => String((item as { name?: unknown }).name)).toSorted()
  return typeof data === "object" && data !== null ? Object.keys(data).toSorted() : []
}
