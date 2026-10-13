import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { agentPermissions, applyUpdatedInput, toClaudeToolCall, validateShellCwd } from "../src/translate/tools.ts"

test("a tools allowlist becomes deny-all followed by specific allows", () => {
  expect(agentPermissions(["Glob", "Grep", "Read", "WebFetch"], undefined)).toEqual([
    { action: "*", resource: "*", effect: "deny" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
  ])
})

test("an agent with no tools field keeps opencode's defaults", () => {
  expect(agentPermissions(undefined, undefined)).toEqual([])
})

test("shell-management tools do not grant shell access", () => {
  const rules = agentPermissions(["Read", "BashOutput", "KillShell"], undefined)
  expect(rules.some((rule) => rule.action === "shell")).toBe(false)
})

test("permission-rule suffixes are ignored when mapping tool names", () => {
  expect(agentPermissions(["Bash(git status:*)"], undefined)).toContainEqual({
    action: "shell",
    resource: "*",
    effect: "allow",
  })
})

test("disallowedTools add denies after the allows", () => {
  expect(agentPermissions(undefined, ["Write", "Edit"])).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
})

test("opencode tool calls are described in Claude Code's vocabulary", () => {
  expect(toClaudeToolCall("shell", { command: "ls", workdir: "/x" })).toEqual({
    name: "Bash",
    input: { command: "ls" },
  })
  expect(toClaudeToolCall("edit", { path: "a.ts", oldString: "x", newString: "y", replaceAll: true })).toEqual({
    name: "Edit",
    input: { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true },
  })
  expect(toClaudeToolCall("write", { path: "a.ts", content: "hi" })).toEqual({
    name: "Write",
    input: { file_path: "a.ts", content: "hi" },
  })
})

test("tools without a Claude counterpart keep their own name and input", () => {
  expect(toClaudeToolCall("context7_resolve", { q: 1 })).toEqual({ name: "context7_resolve", input: { q: 1 } })
})

test("a hook's updatedInput maps back onto opencode field names", () => {
  expect(applyUpdatedInput("shell", { command: "rm -rf /", workdir: "/x" }, { command: "echo safe" })).toEqual({
    command: "echo safe",
    workdir: "/x",
  })
  expect(applyUpdatedInput("write", { path: "a", content: "b" }, { file_path: "c" })).toEqual({
    path: "c",
    content: "b",
  })
})

// WS4 validation matrix: MCP permission opt-in (fail-closed, per-server mcpAllow).

test("WS4: no mcpAllow means zero mcp:call rules", () => {
  const withTools = agentPermissions(["Read"], undefined, undefined)
  expect(withTools).toContainEqual({ action: "*", resource: "*", effect: "deny" })
  expect(withTools.filter((rule) => rule.action === "mcp:call")).toEqual([])
  expect(agentPermissions(undefined, undefined, []).filter((rule) => rule.action === "mcp:call")).toEqual([])
})

test("WS4: tools star never implies MCP", () => {
  expect(agentPermissions(["*"], undefined, ["filesystem:read_file"])).toEqual([])
  expect(
    agentPermissions(["*"], ["Write"], ["filesystem:read_file"]).filter((rule) => rule.action === "mcp:call"),
  ).toEqual([])
})

test("WS4: exact mcpAllow emits both-spelling allows", () => {
  const rules = agentPermissions(undefined, undefined, ["filesystem:read_file"])
  expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
  const allows = rules.filter((rule) => rule.action === "mcp:call" && rule.effect === "allow")
  expect(allows).toEqual([
    { action: "mcp:call", resource: "filesystem:read_file", effect: "allow" },
    { action: "mcp:call", resource: "filesystem:read_file", effect: "allow" },
  ])
  expect(rules.filter((rule) => rule.effect === "deny")).toEqual([{ action: "*", resource: "*", effect: "deny" }])
})

test("WS4: trailing MCP denies win over allows", () => {
  for (const deny of [
    "filesystem:read_file",
    "mcp__filesystem__read_file",
    "mcp__plugin_myplug_filesystem__read_file",
    "filesystem_read_file",
  ]) {
    const rules = agentPermissions(undefined, [deny], ["filesystem:read_file"])
    const allows = rules.filter((rule) => rule.action === "mcp:call" && rule.effect === "allow")
    const denies = rules.filter((rule) => rule.action === "mcp:call" && rule.effect === "deny")
    expect(allows.length).toBe(2)
    expect(denies).toEqual([{ action: "mcp:call", resource: "filesystem:read_file", effect: "deny" }])
    const lastAllow = rules.lastIndexOf(allows[allows.length - 1]!)
    const lastDeny = rules.lastIndexOf(denies[denies.length - 1]!)
    expect(lastDeny).toBeGreaterThan(lastAllow)
  }
})

test("WS4: unscoped mcpAllow is rejected with no grant", () => {
  for (const scoped of [["*"], ["read_file"], ["*:read_file"], ["*:*"], [""]]) {
    const rules = agentPermissions(undefined, undefined, scoped)
    expect(rules.filter((rule) => rule.action === "mcp:call")).toEqual([])
  }
})

test("WS4: suffixed mcpAllow is rejected, not stripped to an over-grant", () => {
  const rules = agentPermissions(undefined, undefined, ["filesystem:read_file(extra)"])
  expect(rules.filter((rule) => rule.action === "mcp:call")).toEqual([])
})

test("WS4: MCP names in tools/disallowedTools alone grant nothing", () => {
  const rules = agentPermissions(["mcp__filesystem__read_file"], undefined, undefined)
  expect(rules).toEqual([{ action: "*", resource: "*", effect: "deny" }])
})

test("WS4: wildcard server-tool allow and ordering with built-ins", () => {
  const rules = agentPermissions(["Read"], ["Write"], ["filesystem:*"])
  expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
  expect(rules).toContainEqual({ action: "read", resource: "*", effect: "allow" })
  expect(rules.filter((rule) => rule.action === "mcp:call" && rule.effect === "allow")).toEqual([
    { action: "mcp:call", resource: "filesystem:*", effect: "allow" },
    { action: "mcp:call", resource: "filesystem:*", effect: "allow" },
  ])
  const mcpAllowLast = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.action === "mcp:call" && rule.effect === "allow")
    .at(-1)!.index
  const editDeny = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.action === "edit" && rule.effect === "deny")
    .at(-1)!.index
  expect(mcpAllowLast).toBeLessThan(editDeny)
})

// WS5 validation matrix: structured cwd (fail-closed to projectDir).

function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), "c4o-ws5-"))
  const sub = path.join(root, "sub")
  mkdirSync(sub)
  const file = path.join(root, "file.txt")
  writeFileSync(file, "hi")
  return { root, sub, file }
}

test("WS5: non-string and empty cwd are ignored", () => {
  const { root } = makeProject()
  try {
    expect(validateShellCwd(undefined, root)).toBeUndefined()
    expect(validateShellCwd(42, root)).toBeUndefined()
    expect(validateShellCwd("", root)).toBeUndefined()
    expect(validateShellCwd("   ", root)).toBeUndefined()
    expect(toClaudeToolCall("shell", { command: "ls" }, root)).toEqual({ name: "Bash", input: { command: "ls" } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: expansion syntax in cwd is ignored with no expansion", () => {
  const { root, sub } = makeProject()
  try {
    for (const cwd of ["${HOME}", "$HOME", "$(whoami)", "`whoami`", "sub/$(whoami)", "sub/${USER}"]) {
      expect(validateShellCwd(cwd, root)).toBeUndefined()
    }
    expect(validateShellCwd("sub", root)).toBe(path.resolve(root, "sub"))
    void sub
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: outside-projectDir cwd is ignored", () => {
  const { root } = makeProject()
  try {
    expect(validateShellCwd("/etc", root)).toBeUndefined()
    expect(validateShellCwd("..", root)).toBeUndefined()
    expect(validateShellCwd(path.join(root, "..", "etc"), root)).toBeUndefined()
    expect(toClaudeToolCall("shell", { command: "ls", cwd: "/etc" }, root)).toEqual({
      name: "Bash",
      input: { command: "ls" },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: symlink escape is ignored", () => {
  const { root } = makeProject()
  const link = path.join(root, "escape")
  try {
    symlinkSync("/etc", link)
    expect(validateShellCwd("escape", root)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: non-existent and file-not-directory cwd are ignored", () => {
  const { root } = makeProject()
  try {
    expect(validateShellCwd("nope", root)).toBeUndefined()
    expect(validateShellCwd("file.txt", root)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: valid subdir cwd is forwarded, cd-prefix gains no semantics", () => {
  const { root, sub } = makeProject()
  try {
    const validated = validateShellCwd("sub", root)!
    expect(validated).toBe(path.resolve(root, "sub"))
    void sub
    expect(toClaudeToolCall("shell", { command: "ls", cwd: "sub" }, root)).toEqual({
      name: "Bash",
      input: { command: "ls", cwd: validated },
    })
    // `cd` prefix is never parsed as cwd.
    expect(toClaudeToolCall("shell", { command: "cd sub && ls" }, root)).toEqual({
      name: "Bash",
      input: { command: "cd sub && ls" },
    })
    // Legacy workdir stays dropped while validated cwd is surfaced.
    expect(toClaudeToolCall("shell", { command: "ls", workdir: "/x", cwd: "sub" }, root)).toEqual({
      name: "Bash",
      input: { command: "ls", cwd: validated },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WS5: hooks cannot set cwd through updatedInput", () => {
  expect(
    applyUpdatedInput("shell", { command: "ls", cwd: "/proj/sub", workdir: "/x" }, { command: "echo safe" }),
  ).toEqual({ command: "echo safe", cwd: "/proj/sub", workdir: "/x" })
  expect(
    applyUpdatedInput("shell", { command: "ls", cwd: "/proj/sub" }, { command: "echo safe", cwd: "/evil" }),
  ).toEqual({ command: "echo safe", cwd: "/proj/sub" })
})
