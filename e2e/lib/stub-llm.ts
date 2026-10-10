/**
 * An OpenAI-compatible chat-completions server that plays the model.
 *
 * Requests that offer tools are agent-loop requests: each consumes the next scripted step.
 * Everything else (session titles and other auxiliary calls) gets a fixed reply and leaves the
 * script alone. Every request is recorded so tests can assert on what opencode sent.
 */

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface Step {
  text?: string
  toolCalls?: ToolCall[]
}

export interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: { type: string; function: { name: string; description?: string } }[]
}

export interface Recorded {
  /** True for agent-loop requests, which consume the script. */
  primary: boolean
  step: Step
  body: ChatRequest
}

export interface Stub {
  /** Base URL to configure as the provider's `baseURL`. */
  url: string
  requests: Recorded[]
  /** Agent-loop requests only, in arrival order. */
  primary(): Recorded[]
  /** Resolves once `count` agent-loop requests have arrived. */
  waitForPrimary(count: number, timeoutMs?: number): Promise<void>
  stop(): void
}

export const EXHAUSTED = "STUB_SCRIPT_EXHAUSTED"

export function startStub(script: Step[]): Stub {
  const requests: Recorded[] = []
  let cursor = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return Response.json({ object: "list", data: [] })
      const body = (await request.json()) as ChatRequest
      const primary = Array.isArray(body.tools) && body.tools.length > 0
      const step: Step = primary ? (script[cursor++] ?? { text: EXHAUSTED }) : { text: "Stub title" }
      requests.push({ primary, step, body })
      return respond(body.model, step, cursor)
    },
  })
  const primary = () => requests.filter((request) => request.primary)
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    primary,
    async waitForPrimary(count, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      while (primary().length < count) {
        if (Date.now() > deadline)
          throw new Error(`Stub saw ${primary().length} agent-loop requests, expected ${count} within ${timeoutMs}ms`)
        await Bun.sleep(50)
      }
    },
    stop: () => void server.stop(true),
  }
}

function respond(model: string, step: Step, sequence: number) {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  const chunks = step.toolCalls?.length
    ? [
        chunk({ role: "assistant", content: null }),
        ...step.toolCalls.map((call, index) =>
          chunk({
            tool_calls: [
              {
                index,
                id: `call_${sequence}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        ),
        { ...chunk({}, "tool_calls"), usage },
      ]
    : [chunk({ role: "assistant", content: step.text ?? "" }), { ...chunk({}, "stop"), usage }]
  return new Response(chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? ""))).join("")
      : content === undefined || content === null
        ? ""
        : JSON.stringify(content)

/** All system-role text of a request, joined. */
export function systemText(request: Recorded) {
  return request.body.messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
}

/** Text of the most recent user message. */
export function lastUserText(request: Recorded) {
  return text(request.body.messages.findLast((message) => message.role === "user")?.content)
}

/** Text of the most recent tool result. */
export function lastToolResult(request: Recorded) {
  return text(request.body.messages.findLast((message) => message.role === "tool")?.content)
}

export function toolNames(request: Recorded) {
  return (request.body.tools ?? []).map((tool) => tool.function.name)
}
