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

/** Collision-free encoding for data directory names into `[A-Za-z0-9_-]`.
 *
 * Claude Code's rule (anything outside `[A-Za-z0-9_-]` becomes `-`) maps
 * `foo.bar@market` and `foo-bar@market` to the same directory. Instead `-` is
 * the escape character: a literal `-` becomes `--`, and any other character
 * outside `[A-Za-z0-9_]` becomes `-<lowercase hex codepoint>-`. `[A-Za-z0-9_]`
 * pass through, so decoding is unambiguous and the mapping is injective. */
export function encodeDataName(value: string) {
  let out = ""
  for (const ch of value) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch
    else if (ch === "-") out += "--"
    else out += `-${ch.codePointAt(0)!.toString(16)}-`
  }
  return out
}

/** Persistent per-plugin data, exposed to plugins as `${CLAUDE_PLUGIN_DATA}`. */
export function dataDirectory(paths: StorePaths, pluginId: string) {
  return path.join(paths.data, encodeDataName(pluginId))
}
