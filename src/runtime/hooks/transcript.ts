import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isRecord } from "../../spec/frontmatter.ts"
import { toClaudeToolCall } from "../../translate/tools.ts"

/**
 * Hooks receive `transcript_path` and some read it, for example to find the last assistant message.
 * opencode keeps history in a database, so this writes the session out in the JSONL shape
 * Claude Code uses: one line per content block, each carrying `message.role` and `message.content`.
 */
export function transcriptLines(messages: readonly unknown[], sessionID: string, cwd: string): string[] {
  const lines: string[] = []
  const line = (type: "user" | "assistant", content: unknown) =>
    lines.push(JSON.stringify({ type, sessionId: sessionID, cwd, message: { role: type, content } }))
  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.type === "user" || message.type === "synthetic") {
      line("user", String(message.text ?? ""))
      continue
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type === "text") line("assistant", [{ type: "text", text: String(part.text ?? "") }])
      if (part.type !== "tool") continue
      const state = isRecord(part.state) ? part.state : {}
      const call = toClaudeToolCall(String(part.name), state.input)
      line("assistant", [{ type: "tool_use", id: part.id, name: call.name, input: call.input }])
      if (state.status !== "completed" && state.status !== "error") continue
      const result = state.status === "completed" ? (state.output ?? state.content ?? "") : (state.error ?? "")
      line("user", [
        {
          type: "tool_result",
          tool_use_id: part.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
          ...(state.status === "error" ? { is_error: true } : {}),
        },
      ])
    }
  }
  return lines
}

export function writeTranscript(
  directory: string,
  sessionID: string,
  cwd: string,
  messages: readonly unknown[],
): string {
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${sessionID.replace(/[^A-Za-z0-9_-]/g, "-")}.jsonl`)
  const lines = transcriptLines(messages, sessionID, cwd)
  writeFileSync(file, lines.length === 0 ? "" : lines.join("\n") + "\n")
  return file
}
