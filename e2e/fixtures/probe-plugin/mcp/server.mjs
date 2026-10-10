// Minimal MCP server over stdio (newline-delimited JSON-RPC). One tool: `shout`.
import { createInterface } from "node:readline"

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === "initialize")
    return reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "probe-echo", version: "1.0.0" },
    })
  if (request.method === "tools/list")
    return reply(request.id, {
      tools: [
        {
          name: "shout",
          description: "Returns the text in upper case with the configured greeting",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
    })
  if (request.method === "tools/call") {
    const text = `${process.env.PROBE_GREETING}: ${String(request.params?.arguments?.text ?? "").toUpperCase()} (root=${process.env.CLAUDE_PLUGIN_ROOT})`
    return reply(request.id, { content: [{ type: "text", text }] })
  }
  if (request.method === "ping") return reply(request.id, {})
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } })
})
