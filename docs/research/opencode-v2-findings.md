# opencode v2 plugin API: what this project depends on

Observed on opencode 2.0.26 with throwaway probe plugins before the design was fixed, and now held in place by the end-to-end tests. The v2 plugin API is in beta; if one of these changes, a test fails.

## Loading and identity

- A plugin is `Plugin.define({ id, setup })` from `@opencode/plugin`. opencode loads `.ts` and `.js` files under `<config>/plugins/`, and anything listed in the `plugins` config field: an npm or git package, or an absolute directory containing a `server` or `index` entry.
- Skill, command and agent IDs may contain `:`. `frontend-design:frontend-design`, `/feature-dev:feature-dev` and the subagent `feature-dev:code-explorer` all register and resolve. MCP server names cannot use it, because opencode derives tool names from them and providers restrict tool names to `[A-Za-z0-9_-]`.
- Plugins activate after a location has booted. The inventory endpoints (`/api/skill`, `/api/command`, `/api/agent`, `/api/mcp`) can answer before a plugin has contributed, so tests poll. Prompts wait for activation.
- `ctx.skill.reload()` and its siblings re-run the plugin's transforms. That is how an install made by `c4o` reaches a running opencode.

## Hook surfaces

| Surface                           | Behavior relied on                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.tool.hook("execute.before")` | The event's `input` is mutable. Throwing rejects the call; the model receives the error message as the tool result. `execute.after` does not fire for a rejected call  |
| `ctx.tool.hook("execute.after")`  | Fires with `status: "completed"` or `"error"`. The completed `result` is mutable, so text can be appended to what the model sees                                       |
| `ctx.session.hook("prompt")`      | The prompt text is mutable. Throwing keeps the prompt out of the session, and the API answers HTTP 500 with an empty body. There is no way to reject with a message    |
| `ctx.session.hook("context")`     | Runs before every model request, with a mutable `system` array. It runs for subagent sessions too                                                                      |
| `ctx.event.subscribe()`           | `session.execution.succeeded` fires when a session finishes a turn, including for subagent sessions. Calling `ctx.session.prompt` from the handler starts another turn |
| `ctx.shell.hook("create.before")` | The `env` of shell tool calls is mutable, which is how `bin/` gets onto `PATH`                                                                                         |

Subagents run as child sessions with a `parentID`. That is how hook events meant for the main conversation are kept away from them.

## Tools

- Built-in tools are `shell`, `read`, `write`, `edit`, `glob`, `grep`, `webfetch`, `websearch`, `subagent`, `skill`, `question`, with camelCase input fields (`path`, `oldString`).
- MCP tools are not offered to the model directly. opencode exposes them through Code Mode: one `execute` tool that runs JavaScript, with each MCP tool at `tools.<server>.<tool>()`. `execute.before` still fires for the inner call, named `<server>_<tool>`.
- An agent's `permissions` are rules of `{ action, resource, effect }`, and the last matching rule wins. Tools an agent is denied are removed from the list offered to the model, not merely refused when called.

## Driving opencode from tests

- `opencode run` treats piped stdin as part of the prompt and waits for it to close. Automation must close stdin.
- `opencode run --standalone` uses a private server. With `HOME` and the `XDG_*` directories pointed at a temporary directory, a run touches nothing else.
- `opencode serve` takes its password from `OPENCODE_PASSWORD` and uses HTTP Basic with the user `opencode`. Requests name their project with `location[directory]=<path>`.
- A provider with `"package": "@ai-sdk/openai-compatible"` and `settings.baseURL` is served by a bundled adapter, so a local stub can play the model with nothing to install. Session titles are requested from the same model, in calls that carry no tools; the stub tells them apart that way.

## Gaps

These are places where a Claude Code behavior has no opencode surface today. Each is reported by `c4o inspect` and in the compatibility report.

- A plugin cannot reject a prompt with a message the user sees.
- A tool hook cannot ask the user to confirm.
- A server plugin has no channel for a notice to the user.
- There is no plugin surface for LSP servers; they are configuration only.
- Nothing distinguishes a session that was cleared or compacted from one that was started, so `SessionStart` reports only `startup` and `resume`.
