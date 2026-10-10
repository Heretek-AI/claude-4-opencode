import { homedir } from "node:os"
import path from "node:path"

export interface StorePaths {
  root: string
  knownMarketplaces: string
  installed: string
  settings: string
  /** Cloned marketplace repositories, one directory per marketplace name. */
  marketplaces: string
  /** Installed plugin versions: `<marketplace>/<plugin>/<version>/`. */
  cache: string
  /** Persistent per-plugin data, exposed to plugins as `${CLAUDE_PLUGIN_DATA}`. */
  data: string
}

/** The store mirrors the layout of Claude Code's `~/.claude/plugins`, under opencode's data directory. */
export function storePaths(env: Record<string, string | undefined> = process.env): StorePaths {
  const root =
    env.C4O_HOME ??
    path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? homedir(), ".local", "share"), "opencode", "claude-plugins")
  return {
    root,
    knownMarketplaces: path.join(root, "known_marketplaces.json"),
    installed: path.join(root, "installed_plugins.json"),
    settings: path.join(root, "settings.json"),
    marketplaces: path.join(root, "marketplaces"),
    cache: path.join(root, "cache"),
    data: path.join(root, "data"),
  }
}

/** Claude Code's rule for data directory names: anything outside `[A-Za-z0-9_-]` becomes `-`. */
export function dataDirectory(paths: StorePaths, pluginId: string) {
  return path.join(paths.data, pluginId.replace(/[^A-Za-z0-9_-]/g, "-"))
}
