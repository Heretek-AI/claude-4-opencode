import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { loadPlugin } from "../src/spec/plugin.ts"
import { conditionMatches, interpret, matcherMatches, runHooks } from "../src/runtime/hooks/engine.ts"
import { transcriptLines } from "../src/runtime/hooks/transcript.ts"
import type { ActivePlugin } from "../src/store/installs.ts"
import { tree } from "./helpers.ts"

/** A plugin whose hooks are small shell scripts, loaded the same way an installed plugin is. */
function pluginWithHooks(hooks: Record<string, unknown>, scripts: Record<string, string> = {}): ActivePlugin {
  const root = tree({ ".claude-plugin/plugin.json": { name: "guard" }, "hooks/hooks.json": { hooks }, ...scripts })
  return {
    id: "guard@test",
    plugin: loadPlugin({ root }),
    dataDir: path.join(root, ".data"),
    options: { level: "strict" },
  }
}

const command = (text: string, extra: Record<string, unknown> = {}) => ({
  hooks: [{ type: "command", command: text, ...extra }],
})
const session = (cwd: string) => ({ sessionID: "ses_1", cwd, transcriptPath: "/tmp/t.jsonl" })

test("matchers: absent, empty and * match everything; otherwise a whole-name regex", () => {
  expect(matcherMatches(undefined, "Bash")).toBe(true)
  expect(matcherMatches("", "Bash")).toBe(true)
  expect(matcherMatches("*", "Bash")).toBe(true)
  expect(matcherMatches("Edit|Write", "Write")).toBe(true)
  expect(matcherMatches("Edit|Write", "MultiEdit")).toBe(false)
  expect(matcherMatches("mcp__.*", "mcp__plugin_x_y__search")).toBe(true)
  expect(matcherMatches("Notebook.*", "NotebookEdit")).toBe(true)
})

test("if conditions narrow by command prefix or file pattern", () => {
  const bash = { name: "Bash", input: { command: "git commit -m x" } }
  expect(conditionMatches("Bash(git commit:*)", bash)).toBe(true)
  expect(conditionMatches("Bash(git push:*)", bash)).toBe(false)
  expect(conditionMatches("Edit(*.ts)", bash)).toBe(false)
  expect(conditionMatches("Edit(*.ts)", { name: "Edit", input: { file_path: "/src/app.ts" } })).toBe(true)
  expect(conditionMatches("Edit(*.ts)", { name: "Edit", input: { file_path: "/src/app.py" } })).toBe(false)
})

test("output protocol: JSON decisions, context and updated input", () => {
  expect(interpret('{"decision":"block","reason":"no"}', "PostToolUse")).toEqual({ blocked: "no" })
  expect(interpret('{"continue":false,"stopReason":"halt"}', "PreToolUse")).toEqual({ blocked: "halt" })
  expect(
    interpret('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"unsafe"}}', "PreToolUse"),
  ).toEqual({ blocked: "unsafe" })
  expect(
    interpret('{"hookSpecificOutput":{"additionalContext":"note","updatedInput":{"command":"ls"}}}', "PreToolUse"),
  ).toEqual({
    context: "note",
    updatedInput: { command: "ls" },
  })
  expect(interpret('{"hookSpecificOutput":{"permissionDecision":"allow"}}', "PreToolUse")).toEqual({})
})

test("systemMessage explains a block that gives no reason, and otherwise reaches the model as a note", () => {
  // hookify denies this way: the rule's message is only in systemMessage.
  expect(
    interpret('{"hookSpecificOutput":{"permissionDecision":"deny"},"systemMessage":"Dangerous rm"}', "PreToolUse"),
  ).toEqual({
    blocked: "Dangerous rm",
  })
  // ralph-loop blocks with the next prompt as the reason; its status line must not replace it.
  expect(interpret('{"decision":"block","reason":"Build it","systemMessage":"iteration 2"}', "Stop")).toEqual({
    blocked: "Build it",
  })
  expect(interpret('{"systemMessage":"console.log left in code"}', "PostToolUse")).toEqual({
    context: "Hook message: console.log left in code",
  })
})

test("a hook that asks for confirmation fails closed", () => {
  const result = interpret(
    '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"risky"}}',
    "PreToolUse",
  )
  expect(result.blocked).toContain("requires user confirmation")
  expect(result.blocked).toContain("risky")
})

test("plain stdout is context only for UserPromptSubmit and SessionStart", () => {
  expect(interpret("remember the style guide\n", "SessionStart")).toEqual({ context: "remember the style guide" })
  expect(interpret("remember the style guide\n", "UserPromptSubmit")).toEqual({ context: "remember the style guide" })
  expect(interpret("formatted 3 files\n", "PostToolUse")).toEqual({})
})

test("exit code 2 blocks with stderr as the reason; other failures do not block", async () => {
  const blocking = pluginWithHooks({ PreToolUse: [command("echo 'rm is not allowed' >&2; exit 2")] })
  expect(
    await runHooks([blocking], { event: "PreToolUse", subject: "Bash", payload: {} }, session(blocking.plugin.root)),
  ).toMatchObject({
    blocked: "rm is not allowed",
    ran: 1,
  })
  const failing = pluginWithHooks({ PreToolUse: [command("echo oops >&2; exit 1")] })
  const outcome = await runHooks(
    [failing],
    { event: "PreToolUse", subject: "Bash", payload: {} },
    session(failing.plugin.root),
  )
  expect(outcome.blocked).toBeUndefined()
})

test("handlers receive the event as JSON on stdin and the plugin's variables in their environment", async () => {
  const plugin = pluginWithHooks(
    { PreToolUse: [command('bash "${CLAUDE_PLUGIN_ROOT}/record.sh"')] },
    {
      "record.sh":
        'cat > "$CLAUDE_PLUGIN_ROOT/stdin.json"\nenv | grep ^CLAUDE_ | sort > "$CLAUDE_PLUGIN_ROOT/env.txt"\n',
    },
  )
  const root = plugin.plugin.root
  await runHooks(
    [plugin],
    { event: "PreToolUse", subject: "Bash", payload: { tool_name: "Bash", tool_input: { command: "ls" } } },
    session(root),
  )
  expect(JSON.parse(readFileSync(path.join(root, "stdin.json"), "utf8"))).toEqual({
    session_id: "ses_1",
    transcript_path: "/tmp/t.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  })
  const env = readFileSync(path.join(root, "env.txt"), "utf8")
  expect(env).toContain(`CLAUDE_PLUGIN_ROOT=${root}`)
  expect(env).toContain(`CLAUDE_PROJECT_DIR=${root}`)
  expect(env).toContain("CLAUDE_PLUGIN_OPTION_LEVEL=strict")
})

test("only handlers whose matcher and condition fit the call run", async () => {
  const plugin = pluginWithHooks({
    PreToolUse: [
      { matcher: "Edit|Write", ...command("echo edits >&2; exit 2") },
      { matcher: "Bash", ...command("echo commits >&2; exit 2", { if: "Bash(git commit:*)" }) },
    ],
  })
  const run = (name: string, input: Record<string, unknown>) =>
    runHooks(
      [plugin],
      { event: "PreToolUse", subject: name, toolCall: { name, input }, payload: {} },
      session(plugin.plugin.root),
    )
  expect((await run("Read", {})).ran).toBe(0)
  expect((await run("Write", {})).blocked).toBe("edits")
  expect((await run("Bash", { command: "git status" })).ran).toBe(0)
  expect((await run("Bash", { command: "git commit -m x" })).blocked).toBe("commits")
})

test("results from several plugins merge, and any block wins", async () => {
  const adviser = pluginWithHooks({ UserPromptSubmit: [command("echo be concise")] })
  const blocker = pluginWithHooks({
    UserPromptSubmit: [command(`echo '{"decision":"block","reason":"secrets in prompt"}'`)],
  })
  const outcome = await runHooks(
    [adviser, blocker],
    { event: "UserPromptSubmit", payload: { prompt: "x" } },
    session(adviser.plugin.root),
  )
  expect(outcome).toEqual({ blocked: "secrets in prompt", context: ["be concise"], ran: 2 })
})

test("exec-form handlers pass arguments without a shell", async () => {
  const plugin = pluginWithHooks({
    SessionStart: [
      { hooks: [{ type: "command", command: "printf", args: ["%s", "root=${CLAUDE_PLUGIN_ROOT}; $(echo not-run)"] }] },
    ],
  })
  const outcome = await runHooks(
    [plugin],
    { event: "SessionStart", subject: "startup", payload: {} },
    session(plugin.plugin.root),
  )
  expect(outcome.context).toEqual([`root=${plugin.plugin.root}; $(echo not-run)`])
})

test("a handler that outlives its timeout is killed and does not block", async () => {
  const plugin = pluginWithHooks({ PreToolUse: [command("sleep 5; exit 2", { timeout: 0.2 })] })
  const started = Date.now()
  const outcome = await runHooks(
    [plugin],
    { event: "PreToolUse", subject: "Bash", payload: {} },
    session(plugin.plugin.root),
  )
  expect(outcome.blocked).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(3000)
})

test("async handlers run in the background and cannot block", async () => {
  const plugin = pluginWithHooks({ PostToolUse: [command("exit 2", { async: true })] })
  const outcome = await runHooks(
    [plugin],
    { event: "PostToolUse", subject: "Bash", payload: {} },
    session(plugin.plugin.root),
  )
  expect(outcome).toEqual({ context: [], ran: 0 })
})

test("transcripts use Claude Code's JSONL shape, one content block per line", () => {
  const lines = transcriptLines(
    [
      { type: "user", text: "fix the bug" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Looking." },
          {
            type: "tool",
            id: "call_1",
            name: "shell",
            state: { status: "completed", input: { command: "ls" }, output: "a.ts" },
          },
          { type: "text", text: "<promise>DONE</promise>" },
        ],
      },
    ],
    "ses_1",
    "/project",
  ).map((line) => JSON.parse(line))
  expect(lines.map((line) => [line.type, line.message.content])).toEqual([
    ["user", "fix the bug"],
    ["assistant", [{ type: "text", text: "Looking." }]],
    ["assistant", [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }]],
    ["user", [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts" }]],
    ["assistant", [{ type: "text", text: "<promise>DONE</promise>" }]],
  ])
  // Hooks such as ralph-loop grep for this exact, unspaced form.
  expect(JSON.stringify(lines[1])).toContain('"role":"assistant"')
})
