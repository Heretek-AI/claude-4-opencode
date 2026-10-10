# Compatibility

Generated from an end-to-end run against the real opencode binary. Do not edit by hand: run `bun run e2e` and then `bun run e2e:report`.

- opencode: `opencode v2.0.26`
- claude-4-opencode: `0.0.1`

## Marketplaces

Every entry of each marketplace resolves, every in-repo plugin loads without errors, and opencode lists every skill, command and agent found. Marketplaces are pinned to the commits in `e2e/targets.lock.json`.

| Marketplace | Commit | Entries | In-repo plugins | Skills | Commands | Agents | MCP servers | Plugins with hooks | LSP servers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [anthropic-agent-skills](https://github.com/anthropics/skills) | `dbd4588` | 5 | 5 | 19 | 0 | 0 | 0 | 0 | 0 |
| [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | `b8e53f1` | 315 | 53 | 31 | 32 | 36 | 13 | 7 | 12 |
| [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | `51aa537` | 1 | 1 | 36 | 0 | 0 | 0 | 0 | 0 |
| [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `95bdacc` | 123 | 22 | 225 | 15 | 5 | 156 | 0 | 0 |
| [superpowers-marketplace](https://github.com/obra/superpowers-marketplace) | `2cf27fa` | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [claude-code-workflows](https://github.com/wshobson/agents) | `46891e7` | 94 | 92 | 184 | 105 | 202 | 0 | 2 | 0 |

## Hook events

How each Claude Code hook event is carried over. Events not listed have no opencode equivalent and are reported by `c4o inspect`.

| Event | Supported | How |
| --- | --- | --- |
| `PreToolUse` | yes | runs before the tool; can block the call, rewrite its input and add context. A request to ask the user blocks instead |
| `PostToolUse` | yes | runs after a successful tool call; feedback is appended to the tool result |
| `PostToolUseFailure` | partial | runs after a failed tool call; its feedback is not delivered to the model |
| `UserPromptSubmit` | partial | runs when a prompt is submitted; context is appended to the prompt, and a blocked prompt is rejected with a generic error |
| `SessionStart` | partial | runs before a session's first model request; context is added to the system prompt. Reports startup or resume, never clear or compact |
| `Stop` | partial | runs when the session finishes a turn; a block continues the session with the reason as the next prompt |
| `SubagentStop` | partial | runs when a subagent session finishes; it cannot be made to continue |
| `SessionEnd` | partial | runs when a session is deleted, not when the client exits |

Events used by plugins in these marketplaces that are not carried over:

| Event | Plugins using it |
| --- | --- |
| `UserPromptExpansion` | 1 |
| `PermissionRequest` | 1 |
| `StopFailure` | 1 |

## Scenarios

32 passed, 0 failed, 10 skipped.

| Suite | Scenario | Result |
| --- | --- | --- |
| claude-plugins-official | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| claude-plugins-official | every external plugin fetches and loads cleanly | skipped |
| anthropic-agent-skills | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| anthropic-agent-skills | every external plugin fetches and loads cleanly | skipped |
| knowledge-work-plugins | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| knowledge-work-plugins | every external plugin fetches and loads cleanly | skipped |
| superpowers-marketplace | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| superpowers-marketplace | every external plugin fetches and loads cleanly | skipped |
| wshobson-agents | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| wshobson-agents | every external plugin fetches and loads cleanly | skipped |
| compound-engineering | every entry resolves and every in-repo plugin loads cleanly, and opencode lists all of it | pass |
| compound-engineering | every external plugin fetches and loads cleanly | skipped |
|  | a marketplace added from GitHub installs and loads: anthropics/skills | pass |
| anthropic-agent-skills matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
| compound-engineering matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
| claude-plugins-official matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
| knowledge-work-plugins matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
| wshobson-agents matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
| superpowers-marketplace matches Claude Code | every plugin exposes the same skills, agents and slash commands | pass |
|  | frontend-design: the model can discover and load the plugin's skill | pass |
|  | installed plugins show up in opencode's inventory under their Claude Code names | pass |
| probe plugin | every component is registered under the plugin's namespace | pass |
| probe plugin | hooks: session context, prompt context, blocking, input rewriting, post-tool feedback | pass |
| probe plugin | hooks: a blocked prompt never reaches the model | pass |
| probe plugin | commands: arguments, plugin paths and shell interpolation with bin/ on PATH | pass |
| probe plugin | skills: plugin path variables are substituted in the body | pass |
| probe plugin | mcp: a stdio server starts from the plugin directory and its tool is callable | pass |
| probe plugin | agents: the system prompt is the agent body and its tool allowlist is enforced | pass |
| probe plugin | bin/: the plugin's executables are on PATH for the model's shell calls | pass |
| official plugins | explanatory-output-style: its SessionStart hook shapes every request | pass |
| official plugins | commit-commands: /commit-commands:commit gathers live git context | pass |
| official plugins | feature-dev: the command takes arguments and its agents run with their own prompt and tools | pass |
| official plugins | hookify: a user rule blocks a matching shell command and leaves others alone | pass |
| official plugins | ralph-loop: the Stop hook feeds the prompt back until the completion promise appears | pass |
| superpowers | its SessionStart hook injects the using-superpowers introduction | pass |
| superpowers | the model can load any of its skills by their Claude Code names | pass |
| superpowers | a skill can be run as a slash command with arguments | pass |
|  | setup, add a marketplace, then install, disable and uninstall while opencode keeps running | pass |
| live model | a real model loads an official plugin's skill when the task calls for it | skipped |
| live model | a plugin's PreToolUse hook stops a real model's tool call | skipped |
| live model | a plugin's SessionStart context reaches a real model | skipped |
| live model | a real model calls a plugin's MCP tool | skipped |

## Plugins

<details><summary>anthropic-agent-skills: 5 plugins</summary>

| Plugin | Skills | Commands | Agents | MCP | Hooks | Not translated |
| --- | --- | --- | --- | --- | --- | --- |
| document-skills | 4 | 0 | 0 | 0 | - | - |
| example-skills | 12 | 0 | 0 | 0 | - | - |
| claude-api | 1 | 0 | 0 | 0 | - | - |
| academy-guide | 1 | 0 | 0 | 0 | - | - |
| discernment-nudge | 1 | 0 | 0 | 0 | - | - |

</details>

<details><summary>claude-plugins-official: 53 plugins</summary>

| Plugin | Skills | Commands | Agents | MCP | Hooks | Not translated |
| --- | --- | --- | --- | --- | --- | --- |
| agent-sdk-dev | 0 | 1 | 2 | 0 | - | - |
| asana | 0 | 1 | 0 | 0 | - | - |
| clangd-lsp | 0 | 0 | 0 | 0 | - | lsp |
| claude-code-setup | 1 | 0 | 0 | 0 | - | - |
| claude-md-management | 1 | 1 | 0 | 0 | - | - |
| claude-security | 1 | 0 | 9 | 0 | UserPromptExpansion (no), PostToolUse (yes), PostToolUseFailure (partial), PermissionRequest (no) | workflows |
| code-modernization | 0 | 13 | 8 | 0 | UserPromptSubmit (partial), Stop (partial), SessionStart (partial), PostToolUseFailure (partial), StopFailure (no) | workflows |
| code-review | 0 | 1 | 0 | 0 | - | - |
| code-simplifier | 0 | 0 | 1 | 0 | - | - |
| commit-commands | 0 | 3 | 0 | 0 | - | - |
| context7 | 0 | 0 | 0 | 1 | - | - |
| csharp-lsp | 0 | 0 | 0 | 0 | - | lsp |
| cwc-makers | 2 | 1 | 0 | 0 | - | - |
| discord | 2 | 0 | 0 | 1 | - | - |
| explanatory-output-style | 0 | 0 | 0 | 0 | SessionStart (partial) | - |
| fakechat | 0 | 0 | 0 | 1 | - | - |
| feature-dev | 0 | 1 | 3 | 0 | - | - |
| firebase | 0 | 0 | 0 | 1 | - | - |
| frontend-design | 1 | 0 | 0 | 0 | - | - |
| github | 0 | 0 | 0 | 1 | - | - |
| gitlab | 0 | 0 | 0 | 1 | - | - |
| gopls-lsp | 0 | 0 | 0 | 0 | - | lsp |
| hookify | 1 | 4 | 1 | 0 | PreToolUse (yes), PostToolUse (yes), Stop (partial), UserPromptSubmit (partial) | - |
| imessage | 2 | 0 | 0 | 1 | - | - |
| jdtls-lsp | 0 | 0 | 0 | 0 | - | lsp |
| kotlin-lsp | 0 | 0 | 0 | 0 | - | lsp |
| laravel-boost | 0 | 0 | 0 | 1 | - | - |
| learning-output-style | 0 | 0 | 0 | 0 | SessionStart (partial) | - |
| linear | 0 | 0 | 0 | 1 | - | - |
| lua-lsp | 0 | 0 | 0 | 0 | - | lsp |
| math-olympiad | 1 | 0 | 0 | 0 | - | - |
| math-proof | 2 | 0 | 3 | 0 | - | - |
| mcp-server-dev | 3 | 0 | 0 | 0 | - | - |
| mcp-tunnels | 0 | 1 | 0 | 0 | - | - |
| php-lsp | 0 | 0 | 0 | 0 | - | lsp |
| playground | 1 | 0 | 0 | 0 | - | - |
| playwright | 0 | 0 | 0 | 1 | - | - |
| plugin-dev | 7 | 1 | 3 | 0 | - | - |
| pr-review-toolkit | 0 | 1 | 6 | 0 | - | - |
| project-artifact | 1 | 0 | 0 | 0 | - | - |
| pyright-lsp | 0 | 0 | 0 | 0 | - | lsp |
| ralph-loop | 0 | 3 | 0 | 0 | Stop (partial) | - |
| receipts | 1 | 0 | 0 | 0 | - | - |
| ruby-lsp | 0 | 0 | 0 | 0 | - | lsp |
| rust-analyzer-lsp | 0 | 0 | 0 | 0 | - | lsp |
| security-guidance | 0 | 0 | 0 | 0 | SessionStart (partial), UserPromptSubmit (partial), PostToolUse (yes), Stop (partial) | - |
| serena | 0 | 0 | 0 | 1 | - | - |
| session-report | 1 | 0 | 0 | 0 | - | - |
| skill-creator | 1 | 0 | 0 | 0 | - | - |
| swift-lsp | 0 | 0 | 0 | 0 | - | lsp |
| telegram | 2 | 0 | 0 | 1 | - | - |
| terraform | 0 | 0 | 0 | 1 | - | - |
| typescript-lsp | 0 | 0 | 0 | 0 | - | lsp |

</details>

<details><summary>compound-engineering-plugin: 1 plugins</summary>

| Plugin | Skills | Commands | Agents | MCP | Hooks | Not translated |
| --- | --- | --- | --- | --- | --- | --- |
| compound-engineering | 36 | 0 | 0 | 0 | - | - |

</details>

<details><summary>knowledge-work-plugins: 22 plugins</summary>

| Plugin | Skills | Commands | Agents | MCP | Hooks | Not translated |
| --- | --- | --- | --- | --- | --- | --- |
| productivity | 4 | 0 | 0 | 7 | - | - |
| enterprise-search | 5 | 0 | 0 | 5 | - | - |
| cowork-plugin-management | 2 | 0 | 0 | 0 | - | - |
| sales | 36 | 0 | 0 | 20 | - | - |
| finance | 8 | 0 | 0 | 2 | - | - |
| data | 10 | 0 | 0 | 6 | - | - |
| legal | 9 | 0 | 0 | 5 | - | - |
| marketing | 8 | 0 | 0 | 11 | - | - |
| customer-support | 5 | 0 | 0 | 6 | - | - |
| product-management | 8 | 1 | 0 | 14 | - | - |
| bio-research | 6 | 0 | 0 | 10 | - | - |
| slack-by-salesforce | 2 | 5 | 0 | 1 | - | - |
| apollo | 3 | 0 | 0 | 1 | - | - |
| common-room | 6 | 2 | 0 | 1 | - | - |
| engineering | 10 | 0 | 0 | 8 | - | - |
| human-resources | 9 | 0 | 0 | 3 | - | - |
| design | 7 | 0 | 0 | 7 | - | - |
| operations | 9 | 0 | 0 | 4 | - | - |
| small-business | 44 | 0 | 0 | 35 | - | - |
| brand-voice | 3 | 3 | 5 | 6 | - | - |
| zoom-plugin | 30 | 0 | 0 | 3 | - | - |
| pdf-viewer | 1 | 4 | 0 | 1 | - | - |

</details>

<details><summary>claude-code-workflows: 92 plugins</summary>

| Plugin | Skills | Commands | Agents | MCP | Hooks | Not translated |
| --- | --- | --- | --- | --- | --- | --- |
| documentation-standards | 2 | 0 | 0 | 0 | - | - |
| code-documentation | 0 | 2 | 3 | 0 | - | - |
| debugging-toolkit | 0 | 1 | 2 | 0 | - | - |
| git-pr-workflows | 0 | 3 | 1 | 0 | - | - |
| operating-kit | 0 | 0 | 5 | 0 | - | - |
| backend-development | 9 | 1 | 8 | 0 | - | - |
| frontend-mobile-development | 4 | 1 | 2 | 0 | - | - |
| full-stack-orchestration | 0 | 1 | 4 | 0 | - | - |
| unit-testing | 0 | 1 | 2 | 0 | - | - |
| tdd-workflows | 0 | 4 | 2 | 0 | - | - |
| code-refactoring | 0 | 3 | 2 | 0 | - | - |
| dependency-management | 0 | 1 | 1 | 0 | - | - |
| error-debugging | 0 | 3 | 2 | 0 | - | - |
| team-collaboration | 0 | 2 | 1 | 0 | - | - |
| llm-application-dev | 8 | 3 | 3 | 0 | - | - |
| llm-finetuning | 10 | 2 | 3 | 0 | - | - |
| agent-orchestration | 0 | 2 | 1 | 0 | - | - |
| context-management | 0 | 2 | 1 | 0 | - | - |
| machine-learning-ops | 2 | 1 | 3 | 0 | - | - |
| data-engineering | 4 | 2 | 2 | 0 | - | - |
| incident-response | 4 | 2 | 6 | 0 | - | - |
| error-diagnostics | 0 | 3 | 2 | 0 | - | - |
| distributed-debugging | 0 | 1 | 2 | 0 | - | - |
| observability-monitoring | 4 | 2 | 4 | 0 | - | - |
| deployment-strategies | 0 | 0 | 2 | 0 | - | - |
| deployment-validation | 0 | 1 | 1 | 0 | - | - |
| kubernetes-operations | 4 | 0 | 1 | 0 | - | - |
| cloud-infrastructure | 8 | 0 | 7 | 0 | - | - |
| cicd-automation | 4 | 1 | 5 | 0 | - | - |
| application-performance | 0 | 1 | 3 | 0 | - | - |
| database-cloud-optimization | 0 | 1 | 4 | 0 | - | - |
| comprehensive-review | 0 | 2 | 3 | 0 | - | - |
| performance-testing-review | 0 | 2 | 2 | 0 | - | - |
| framework-migration | 4 | 3 | 2 | 0 | - | - |
| codebase-cleanup | 0 | 3 | 2 | 0 | - | - |
| database-design | 1 | 0 | 2 | 0 | - | - |
| database-migrations | 0 | 2 | 2 | 0 | - | - |
| security-scanning | 5 | 3 | 2 | 0 | - | - |
| security-compliance | 0 | 1 | 1 | 0 | - | - |
| backend-api-security | 0 | 0 | 2 | 0 | - | - |
| frontend-mobile-security | 0 | 1 | 3 | 0 | - | - |
| data-validation-suite | 0 | 0 | 1 | 0 | - | - |
| api-scaffolding | 1 | 0 | 4 | 0 | - | - |
| api-testing-observability | 0 | 1 | 1 | 0 | - | - |
| seo-content-creation | 0 | 0 | 3 | 0 | - | - |
| seo-technical-optimization | 0 | 0 | 4 | 0 | - | - |
| seo-analysis-monitoring | 0 | 0 | 3 | 0 | - | - |
| documentation-generation | 3 | 1 | 5 | 0 | - | - |
| c4-architecture | 0 | 1 | 4 | 0 | - | - |
| avoid-ai-writing | 1 | 0 | 0 | 0 | - | - |
| multi-platform-apps | 0 | 1 | 6 | 0 | - | - |
| business-analytics | 2 | 0 | 1 | 0 | - | - |
| startup-business-analyst | 5 | 3 | 1 | 0 | - | - |
| before-you-build | 1 | 0 | 0 | 0 | - | - |
| hr-legal-compliance | 2 | 0 | 2 | 0 | - | - |
| customer-sales-automation | 0 | 0 | 2 | 0 | - | - |
| content-marketing | 0 | 0 | 2 | 0 | - | - |
| social-publishing | 1 | 0 | 1 | 0 | - | - |
| hermes-tweet | 1 | 0 | 0 | 0 | - | - |
| blockchain-web3 | 4 | 0 | 1 | 0 | - | - |
| quantitative-trading | 2 | 0 | 2 | 0 | - | - |
| payment-processing | 4 | 0 | 1 | 0 | - | - |
| game-development | 2 | 0 | 2 | 0 | - | - |
| accessibility-compliance | 2 | 1 | 1 | 0 | - | - |
| python-development | 16 | 1 | 3 | 0 | - | - |
| javascript-typescript | 4 | 1 | 2 | 0 | - | - |
| systems-programming | 3 | 1 | 4 | 0 | - | - |
| jvm-languages | 0 | 0 | 3 | 0 | - | - |
| web-scripting | 0 | 0 | 2 | 0 | - | - |
| functional-programming | 0 | 0 | 2 | 0 | - | - |
| julia-development | 0 | 0 | 1 | 0 | - | - |
| arm-cortex-microcontrollers | 0 | 0 | 1 | 0 | - | - |
| shell-scripting | 3 | 0 | 2 | 0 | - | - |
| developer-essentials | 11 | 0 | 1 | 0 | - | - |
| dgx-spark-ops | 3 | 1 | 1 | 0 | - | - |
| reverse-engineering | 4 | 0 | 3 | 0 | - | - |
| conductor | 3 | 6 | 1 | 0 | - | - |
| superself | 1 | 0 | 0 | 0 | - | - |
| ui-design | 9 | 4 | 3 | 0 | - | - |
| agent-teams | 6 | 7 | 4 | 0 | - | - |
| dotnet-contribution | 1 | 0 | 1 | 0 | - | - |
| meigen-ai-design | 0 | 2 | 3 | 0 | - | - |
| brand-landingpage | 1 | 0 | 0 | 0 | - | - |
| plugin-eval | 1 | 3 | 2 | 0 | - | - |
| block-no-verify | 1 | 1 | 0 | 0 | - | - |
| protect-mcp | 1 | 2 | 2 | 0 | PreToolUse (yes), PostToolUse (yes) | - |
| signed-audit-trails | 1 | 0 | 0 | 0 | - | - |
| review-agent-governance | 1 | 2 | 1 | 0 | PreToolUse (yes), PostToolUse (yes) | - |
| ship-mate | 1 | 2 | 6 | 0 | - | - |
| file-conversion | 1 | 0 | 0 | 0 | - | - |
| skill-forge-essentials | 3 | 0 | 0 | 0 | - | - |
| pptx-deck-creation | 5 | 0 | 1 | 0 | - | - |

</details>

