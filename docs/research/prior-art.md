# Prior art

Researched in October 2026, before and during the first implementation. The question was whether anyone had already made Claude Code plugins and marketplaces work on opencode v2.

**Short answer:** parts of it exist, for opencode v1 or as one-off file conversion. Nothing found loads Claude Code plugins on opencode v2, and nothing found combines marketplace management with runtime support for hooks.

## What exists

| Project                                                                                                       | Approach                                                                                                                                                                    | Covers                                                                                                                 | Does not cover                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (formerly oh-my-opencode), about 70k stars | Runtime compatibility layer inside a larger opencode plugin. Its `claude-code-compat-core` package has loaders for plugins, commands, agents, MCP servers, skills and hooks | Reads what Claude Code itself installed, from `~/.claude/plugins/installed_plugins.json` and `~/.claude/settings.json` | opencode v2: it depends on `@opencode-ai/plugin` 1.18.31, and v2 support is an open request ([#8485](https://github.com/code-yeongyu/oh-my-openagent/issues/8485), [#6169](https://github.com/code-yeongyu/oh-my-openagent/issues/6169)). It does not add marketplaces or install plugins; Claude Code has to do that first. Licensed under a Sustainable Use License, so it is not a base to build on |
| [gzb1128/opencode-plugin](https://github.com/gzb1128/opencode-plugin), MIT, 2 stars                           | Go CLI that adds Claude Code marketplaces and installs plugins. Its end-to-end test clones the official marketplace                                                         | Skills, symlinked into `~/.agents/skills`                                                                              | Commands, agents, MCP servers, hooks. Its README says only `skills/` are linked. No runtime component                                                                                                                                                                                                                                                                                                  |
| [compound-plugin](https://github.com/EveryInc/compound-engineering-plugin) by Every, MIT, about 25k stars     | `compound-plugin convert <dir> --to opencode` rewrites a Claude Code plugin into another tool's file format, for about ten target tools                                     | Agents, commands, skills and MCP servers, per its documentation                                                        | Hooks, marketplaces, anything at runtime. A converted plugin is a copy that has to be converted again when the original changes                                                                                                                                                                                                                                                                        |
| opencode v2 itself                                                                                            | A built-in `opencode.config.compatibility` plugin                                                                                                                           | Loose skills under `.claude/skills` and `.agents/skills`                                                               | Plugins, marketplaces, commands, agents, MCP servers, hooks                                                                                                                                                                                                                                                                                                                                            |

Some plugin authors ship their own opencode port next to the Claude Code plugin: [superpowers](https://github.com/obra/superpowers) carries an `.opencode/` directory, and [wshobson/agents](https://github.com/wshobson/agents) describes itself as a multi-harness marketplace. That works plugin by plugin and relies on each author.

## Relevant upstream discussion

- [anomalyco/opencode#50133](https://github.com/anomalyco/opencode/issues/50133): a plugin author maps Claude Code's hook events onto opencode's plugin API and lists seven gaps. Several match what this project found (no signal for failed tool calls beyond a status, no working directory on tool hooks, no per-agent hooks).
- [anomalyco/opencode#53402](https://github.com/anomalyco/opencode/issues/53402): v2 has no `CLAUDE.md` fallback.
- [anomalyco/opencode#47345](https://github.com/anomalyco/opencode/issues/47345): a request to expose the plugin manager as a slash command.
- [anomalyco/opencode#8386](https://github.com/anomalyco/opencode/issues/8386) (closed): a request for a skill registry and installer.

No issue or pull request was found that proposes Claude Code plugin or marketplace support in opencode.

## How this project differs

- It targets the opencode v2 plugin API (`@opencode/plugin`, `Plugin.define`), which is a hard break from v1.
- It manages marketplaces and installs itself, with the same on-disk model as Claude Code, and does not need Claude Code installed.
- It works at runtime on the unmodified plugin, so hooks, `${CLAUDE_PLUGIN_ROOT}` and enable/disable behave as plugin authors expect, and updates need no reconversion.
- Its claims are checked against real Claude Code: the names it gives components are compared with what Claude Code lists for the same plugins at the same commits.

## Sources used for the implementation

The format is implemented from Anthropic's public documentation:

- [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks)

and exercised against Anthropic's public repositories: [claude-plugins-official](https://github.com/anthropics/claude-plugins-official), [skills](https://github.com/anthropics/skills) and [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins).

Popularity figures come from the install statistics Anthropic publishes on the `stats` branch of claude-plugins-official ([plugin-installs.json](https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json)). The snapshot of 2 October 2026 lists 322 plugins and about 10.3 million unique installs. The ten most installed were frontend-design (1.29M), superpowers (1.15M), code-review (492k), context7 (458k), skill-creator (440k), code-simplifier (383k), playwright (367k), github (354k), claude-md-management (322k) and vercel (285k). The behavioral test set was chosen from that list so that every component type is covered.

A reimplementation of Claude Code was consulted only to confirm behavior the documentation leaves open, such as how skill and command names are derived. Its license notes that it derives from proprietary source, so no code was taken from it. Those behaviors are now pinned by the golden files instead, which record real Claude Code's output.
