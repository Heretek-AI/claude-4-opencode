export interface VarContext {
  /** `${CLAUDE_PLUGIN_ROOT}`: the installed plugin directory. */
  pluginRoot: string
  /** `${CLAUDE_PLUGIN_DATA}`: persistent per-plugin data directory. */
  pluginData: string
  /** `${CLAUDE_PROJECT_DIR}`: the project the session runs in. */
  projectDir: string
  /** Saved `userConfig` values, referenced as `${user_config.KEY}`. */
  userConfig: Record<string, unknown>
}

const PATTERN =
  /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|user_config\.([A-Za-z_][A-Za-z0-9_]*))\}/g

/** Substitutes the plugin path variables and `user_config` references Claude Code resolves inline. */
export function substitute(text: string, context: VarContext): string {
  return text.replace(PATTERN, (whole, name: string, key: string | undefined) => {
    if (name === "CLAUDE_PLUGIN_ROOT") return context.pluginRoot
    if (name === "CLAUDE_PLUGIN_DATA") return context.pluginData
    if (name === "CLAUDE_PROJECT_DIR") return context.projectDir
    const value = key === undefined ? undefined : context.userConfig[key]
    return value === undefined || value === null ? whole : String(value)
  })
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Like `substitute`, and also expands `${VAR}` and `${VAR:-default}` from the environment,
 * which MCP and LSP server definitions use for credentials.
 */
export function substituteWithEnv(text: string, context: VarContext, env: Record<string, string | undefined>): string {
  return substitute(text, context).replace(ENV_PATTERN, (whole, name: string, fallback: string | undefined) => {
    return env[name] ?? fallback ?? whole
  })
}

/** Environment exported to hook and MCP processes. */
export function pluginEnvironment(context: VarContext): Record<string, string> {
  const options = Object.entries(context.userConfig).flatMap(([key, value]): [string, string][] =>
    value === undefined || value === null ? [] : [[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`, String(value)]],
  )
  return {
    CLAUDE_PLUGIN_ROOT: context.pluginRoot,
    CLAUDE_PLUGIN_DATA: context.pluginData,
    CLAUDE_PROJECT_DIR: context.projectDir,
    ...Object.fromEntries(options),
  }
}
