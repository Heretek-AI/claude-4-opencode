# RFC — WS5: structured `cwd` handling (design only, not implemented)

Status: proposed. No code changed. Implements plan §3-WS5.
Refs: `src/translate/tools.ts:72-77,97-111`, `src/runtime/hooks/engine.ts:124-137`,
`src/translate/commands.ts:126-182`.

## Background (Drift A, current behavior)

Shell `workdir` has no Claude counterpart and is intentionally unmapped:
`toClaudeToolCall` drops it (pinned by `test/tools.test.ts:35-48`) so
matchers never see it, while `applyUpdatedInput` preserves it via spread
so hooks cannot clobber it. Command bodies run with `cwd: projectDir`
(`commands.ts:169`, `server.ts:91`); hook processes spawn with
`cwd: session.cwd` (`engine.ts:201`).

## Decision (locked)

Adopt a structured `{cwd: string}` validated field. Reject
`cd <dir> && ...` prefixing as a cwd carrier. Keep dropping `workdir`
until hook visibility ships.

## Proposal (not yet implemented)

1. Accept `cwd` only as a structured string field on shell tool input
   (`{cwd: string}` sibling of `command`). Never parse it out of the
   command text; a command starting with `cd <dir> &&` stays a plain
   command with no cwd semantics.
2. Validation pipeline, in order:
   - type gate: `typeof cwd === "string"` and non-empty, else ignore;
   - no shell expansion: no `${...}`, `$VAR`, backticks, `$(...)`
     interpretation — value is literal text;
   - `path.resolve(projectDir, cwd)` then `realpath` both sides;
   - containment: real cwd must equal real `projectDir` or start with
     real `projectDir + path.sep` (symlink-aware);
   - must exist and `isDirectory`, else ignore (fail-closed to
     `projectDir`).
3. Surface validated cwd to hooks: include it in `toClaudeToolCall`
   output for `shell` and in `conditionMatches` visibility, so `if`
   conditions and matchers can test it. Until that ships, keep the
   current drop behavior — no partial forwarding (e.g. no
   `working_directory` alias, no reverse map).
4. `applyUpdatedInput` continues to preserve the original cwd via spread;
   hooks cannot set cwd through `updatedInput` until the visibility
   work above lands and is pinned by tests.

## Validation matrix (future tests)

- [ ] non-string/empty cwd → ignored, `projectDir` used.
- [ ] `$(...)`/`${...}` in cwd → ignored, no expansion.
- [ ] outside-projectDir cwd (incl. symlink escape) → ignored.
- [ ] non-existent/file-not-directory cwd → ignored.
- [ ] valid subdir cwd → forwarded to hooks once visibility ships.

## Non-goals

No `cd`-prefix parsing. No shell-expansion of cwd. No hook-writable cwd
until visibility ships. No implementation until this RFC is approved.
