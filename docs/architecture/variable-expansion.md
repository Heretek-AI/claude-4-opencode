# Variable expansion invariants (WS6)

Frozen by Wave 3. Implementation: `src/translate/vars.ts:1-53`.
Call sites: `src/translate/components.ts:20-57,90-127`,
`src/translate/commands.ts:147`, `src/runtime/hooks/engine.ts:194-267`.
Pinned by `test/vars.test.ts`. Upstream context:
`docs/research/opencode-v2-findings.md:47-48`.

## Invariants

- **I-1 — Unidirectional, dialect-preserving.** `${VAR}`/`${VAR:-default}`
  expand here at translation time. Opencode-native `{env:VAR}` is never
  expanded here and never emitted: it passes through byte-identical
  (regression test). Likewise `${VAR}` is left literal for opencode
  native config to treat literally (drift E, intentional).
- **I-2 — `substitute` has no env.** Expands only `CLAUDE_PLUGIN_ROOT`,
  `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, and
  `${user_config.KEY}`. `process.env` is invisible to it. Used for
  skills (`components.ts:27`), agents (`components.ts:52`), command
  bodies (`commands.ts:147`), and hook commands/args (`engine.ts:194-197`).
- **I-3 — `substituteWithEnv` = `substitute` + explicit env.** Second pass
  expands `${VAR}` / `${VAR:-default}` strictly from the passed `env`
  param, never from ambient `process.env` directly.
- **I-4 — MCP/LSP are full-env by design.** `toMcp`/`toLsp`
  (`components.ts:90-127`) call `substituteWithEnv` with `process.env`,
  so marketplace MCP credentials (`${TOKEN}`, `${KEY:-default}`) keep
  working. This is the only full-env path.
- **I-5 — HTTP hooks are allowlist-only.** `runHttp` (`engine.ts:250-255`)
  builds `env` solely from `handler.allowedEnvVars`; when absent, nothing
  from the environment expands and `${SECRET}` stays literal, so a hook
  cannot exfiltrate unrelated secrets. Pinned by
  `test/hooks.test.ts:426-452`.
- **I-6 — Model-visible text never carries env.** Skill bodies, agent
  `system`, and rendered command text go through `substitute` (I-2), so
  secret values from the environment can never leak into model context
  through expansion. Secrets reach only MCP/LSP processes (I-4) and
  allowlisted HTTP hooks (I-5).
- **I-7 — Missing is literal; single-pass, no recursion.** Unknown names
  (and `${VAR}` with no env entry and no `:-default`) stay literal.
  Expansion is one left-to-right pass: replacement values are not
  rescanned, so a `userConfig` value containing `${CLAUDE_PLUGIN_ROOT}`
  is inserted literally (verified: `"${CLAUDE_PLUGIN_ROOT}/x"` survives).

## Non-goals

No bidirectional translation (`${VAR}` ↔ `{env:VAR}`). No `{env:}`
emission. No recursive expansion. No ambient-env reads outside the
three call sites named above.
