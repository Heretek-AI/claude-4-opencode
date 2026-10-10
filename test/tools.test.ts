import { expect, test } from "bun:test"
import { agentPermissions, applyUpdatedInput, toClaudeToolCall } from "../src/translate/tools.ts"

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
