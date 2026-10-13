# RFC — WS4: MCP permission opt-in (implemented)

Status: implemented after approval. Implements plan §1-D2 + §3-WS4.
Refs: `src/translate/tools.ts:12-56`, `src/translate/components.ts:40-57`,
`src/runtime/hooks/bind.ts:95-108`, `test/tools.test.ts:4-63`.

## Background (Drift G, fail-closed)

`agentPermissions(tools, disallowedTools)` maps Claude built-in tool names
via `ACTIONS` to opencode `{action, resource, effect}` rules with
`resource: "*"` only. Names absent from `ACTIONS` — including every
`mcp__*` / MCP-plugin spelling — grant nothing. `*` in `tools` is a
passthrough (no deny-all, no rules). `disallowedTools` appends trailing
denies; opencode applies last-match-wins. Hook `ask` fails closed
(`src/runtime/hooks/engine.ts:290-294`).

## Decision D2 (locked)

Default stays deny-all. MCP access is opt-in only via an explicit
per-server declaration. `*` never implies MCP.

## Proposal (not yet implemented)

1. New optional agent frontmatter field `mcpAllow: string[]`, entries
   `"<server>:<tool>"` or `"<server>:*"` (per-server scope; a bare `"*"`
   or `"<tool>"` without a server is rejected as unscoped).
2. Translation, appended after built-in allows and before trailing denies:
   - leading `{action:"*", resource:"*", effect:"deny"}` (when allowlist
     semantics apply, mirroring current behavior),
   - built-in allows from `tools` (unchanged),
   - for each `mcpAllow` triple, two allows covering both spellings:
     Code-Mode inner `<server>_<tool>` (as seen by `execute.before`,
     `docs/research/opencode-v2-findings.md:28`) and hook
     `mcp__plugin_<plugin>_<server>__<tool>` (as built by `describe`
     in `bind.ts:95-108`). Example for `filesystem:read_file`:
     ```json
     [
       { "action": "*", "resource": "*", "effect": "deny" },
       { "action": "mcp:call", "resource": "filesystem:read_file", "effect": "allow" }
     ]
     ```
     emitted once per spelling with the same `resource` triple.
   - trailing denies from `disallowedTools` win, including MCP denies
     (`mcpAllow` entry also listed in `disallowedTools` flips to deny).
3. Suffix-stripping (`toolName`, `tools.ts:31-35`) must NOT apply to
   `mcpAllow` entries: `filesystem:read_file(extra)` is rejected, not
   stripped to an over-grant.

## Validation matrix (to pin with tests mirroring `test/tools.test.ts:4-63`)

- [ ] no `mcpAllow` → zero `mcp:call` rules (current deny-all preserved).
- [ ] `tools: ["*"]` → no MCP rules (`*` never implies MCP).
- [ ] exact `mcpAllow: ["filesystem:read_file"]` → both-spelling allows
      present before trailing denies.
- [ ] `mcpAllow: ["filesystem:read_file"]` +
      `disallowedTools: ["mcp__filesystem__read_file"]` (or equivalent
      spelling) → trailing deny wins.
- [ ] unscoped `mcpAllow: ["*"]` / `["read_file"]` → rejected, no grant.

## Non-goals

No `resource` scoping beyond the exact triple. No per-file/per-path MCP
resources. No change to `ACTIONS` or built-in mapping.
