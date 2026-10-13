/** A problem found while reading a plugin or marketplace. Readers collect these instead of throwing. */
export interface Issue {
  level: "error" | "warning"
  message: string
  path?: string
}

export interface SkillDef {
  /** Namespaced as Claude Code does: `<plugin>:<skill directory name>`. */
  id: string
  /** Frontmatter `name` when present, otherwise the directory name. Display only. */
  displayName: string
  description?: string
  /** Absolute path of SKILL.md. Relative references in the body resolve against its directory. */
  path: string
  body: string
  frontmatter: Record<string, unknown>
  disableModelInvocation: boolean
}

export interface CommandDef {
  /** `<plugin>:<name>`, with subdirectories as further `:` segments. */
  id: string
  description?: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
  body: string
  /** Absolute source file. Absent for inline `content` commands. */
  path?: string
  frontmatter: Record<string, unknown>
}

export interface AgentDef {
  id: string
  description?: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
  color?: string
  body: string
  path: string
  frontmatter: Record<string, unknown>
}

export interface CommandHook {
  type: "command"
  command: string
  args?: string[]
  timeout?: number
  shell?: string
  async?: boolean
  if?: string
}

export interface HttpHook {
  type: "http"
  url: string
  headers?: Record<string, string>
  timeout?: number
  async?: boolean
  if?: string
  /**
   * Environment variables visible to `${VAR}` expansion in `url` and `headers`.
   * When absent nothing from the process environment expands, which keeps
   * secrets out of hook definitions that did not ask for them.
   */
  allowedEnvVars?: string[]
}

/** Hook types the first release reads but does not run: `prompt`, `agent`, `mcp_tool`. */
export interface OtherHook {
  type: string
  [key: string]: unknown
}

export type HookHandler = CommandHook | HttpHook | OtherHook

export interface HookMatcher {
  matcher?: string
  hooks: HookHandler[]
}

export type HookConfig = Record<string, HookMatcher[]>

export type McpServerDef =
  | {
      type: "stdio"
      command: string
      args: string[]
      env: Record<string, string>
      /** Retained from the manifest but not forwarded: opencode local MCP has no `cwd` field. */
      cwd?: string
      /** Retained from the manifest but not forwarded: opencode MCP has no per-server `timeout`. */
      timeout?: number
    }
  | {
      type: "http" | "sse" | "ws"
      url: string
      headers: Record<string, string>
      /** Retained from the manifest but not forwarded: opencode MCP has no per-server `timeout`. */
      timeout?: number
    }

export interface LspServerDef {
  command: string
  args: string[]
  extensionToLanguage: Record<string, string>
  env: Record<string, string>
  initializationOptions?: Record<string, unknown>
}

export interface UserConfigOption {
  type?: string
  title?: string
  description?: string
  required?: boolean
  default?: unknown
  sensitive?: boolean
}

export interface PluginManifest {
  name?: string
  displayName?: string
  version?: string
  description?: string
  defaultEnabled?: boolean
  dependencies?: unknown
  userConfig?: Record<string, UserConfigOption>
  commands?: unknown
  agents?: unknown
  skills?: unknown
  hooks?: unknown
  mcpServers?: unknown
  lspServers?: unknown
  outputStyles?: unknown
  [key: string]: unknown
}

/** A component kind that exists in the plugin but has no opencode translation. */
export interface Unsupported {
  kind: string
  detail: string
}

export interface LoadedPlugin {
  name: string
  root: string
  version?: string
  manifest: PluginManifest
  skills: SkillDef[]
  commands: CommandDef[]
  agents: AgentDef[]
  hooks: HookConfig
  mcpServers: Record<string, McpServerDef>
  lspServers: Record<string, LspServerDef>
  /** Absolute path of `bin/` when the plugin ships one. */
  binDir?: string
  unsupported: Unsupported[]
  issues: Issue[]
}

/**
 * A relative path inside the marketplace, or an object whose `source` names the kind:
 * `github` (repo), `url` (git url), `git-subdir` (url + path) or `npm` (package).
 * The fields are untrusted JSON, so `resolveSource` validates them.
 */
export type PluginSource = string | { source: string; [key: string]: unknown }

/** One `plugins[]` entry of marketplace.json. Carries the same component keys a manifest can. */
export interface MarketplaceEntry extends PluginManifest {
  name: string
  source: PluginSource
  strict?: boolean
  category?: string
}

export interface Marketplace {
  name: string
  owner?: { name?: string; email?: string; url?: string }
  metadata?: { pluginRoot?: string; version?: string; description?: string }
  plugins: MarketplaceEntry[]
}
