# claude-4-opencode

Run Claude Code plugins on [opencode](https://opencode.ai) v2, and install them from Claude Code marketplaces.

It has two parts. `c4o` is a command-line tool that adds marketplaces and installs plugins, the way `claude plugin` does. The other part is an opencode plugin that loads what `c4o` installed and registers each plugin's skills, commands, agents, MCP servers and hooks with opencode. Plugins are used as published; nothing is converted or rewritten on disk.

Whether it works is checked end to end against the real opencode binary, using unmodified plugins from the most-installed marketplaces. See [What is tested](#what-is-tested) and [COMPATIBILITY.md](COMPATIBILITY.md).

## Getting started

Requires opencode 2.x, git, and Node 22 or later. Building needs [Bun](https://bun.sh).

```sh
git clone https://github.com/Heretek-AI/claude-4-opencode
cd claude-4-opencode
bun install && bun run build
alias c4o="node $PWD/dist/cli.js"

c4o setup                                                  # adds the plugin to opencode's config
c4o marketplace add anthropics/claude-plugins-official
c4o install superpowers feature-dev commit-commands
```

Start opencode. The plugins' skills are available to the model, their commands run as `/feature-dev:feature-dev`, and their hooks are active. A running opencode picks up later installs without a restart.

`c4o inspect <plugin>` shows what a plugin contributes and what could not be carried over. Run it before installing a plugin you do not know: hooks and MCP servers run commands on your machine, exactly as they do in Claude Code.

## Commands

| Command                                                    | What it does                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `c4o marketplace add <source>`                             | Adds a marketplace: `owner/repo`, `owner/repo@ref`, a git URL, a `marketplace.json` URL, or a local path |
| `c4o marketplace list` / `update [name]` / `remove <name>` | Manages added marketplaces                                                                               |
| `c4o install <plugin>[@marketplace] ...`                   | Installs plugins. The marketplace can be left out when only one lists the plugin                         |
| `c4o update [plugin ...]`                                  | Refreshes marketplaces and reinstalls plugins at what they now point to                                  |
| `c4o enable` / `disable` / `uninstall <plugin>`            | Turns a plugin on or off, or removes it                                                                  |
| `c4o list`                                                 | Shows installed plugins                                                                                  |
| `c4o inspect <plugin or directory>`                        | Reports a plugin's components, hook support, and anything not translated                                 |
| `c4o setup`                                                | Registers the opencode plugin in opencode's global config                                                |
| `c4o doctor`                                               | Checks git, opencode, registration, and that installed plugins load                                      |

Add `--json` to any command for machine-readable output.

## What is translated

| Claude Code                                                                                     | In opencode                                                       | Notes                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills                                                                                          | Skills, named `plugin:skill`                                      | Also runnable as `/plugin:skill args`, as in Claude Code                                                                                                               |
| Commands                                                                                        | Commands, named `plugin:command`                                  | `$ARGUMENTS`, `$0`..`$N`, named arguments, `` !`shell` `` and fenced `!` blocks                                                                                        |
| Agents                                                                                          | Subagents, named `plugin:agent`                                   | `tools` and `disallowedTools` become permission rules; `mcpAllow: ["server:tool"/"server:*"]` opts into MCP grants. `model` is ignored; agents use the session's model |
| MCP servers                                                                                     | MCP servers, named `plugin_server`                                | stdio and remote. `${VAR}` and `${VAR:-default}` are expanded from the environment                                                                                     |
| Hooks                                                                                           | See the table in [COMPATIBILITY.md](COMPATIBILITY.md#hook-events) | `command` and `http` handlers run. `prompt`, `agent` and `mcp_tool` handlers do not                                                                                    |
| `bin/`                                                                                          | On `PATH` for shell tool calls and command interpolation          |                                                                                                                                                                        |
| `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${user_config.KEY}` | Substituted wherever Claude Code substitutes them                 |                                                                                                                                                                        |

Not translated, and reported by `c4o inspect` rather than dropped silently: LSP servers, output styles, monitors, themes, workflows, channels, mods, and plugin `settings.json`.

Hooks are written against Claude Code's tool names and input fields. They receive opencode tool calls in that vocabulary (`shell` arrives as `Bash` with `command`, `edit` as `Edit` with `file_path`, a plugin's MCP tool as `mcp__plugin_<plugin>_<server>__<tool>`), plus a transcript file in Claude Code's JSONL format.

### Differences worth knowing

- A `UserPromptSubmit` hook that blocks a prompt does stop it from reaching the model, but opencode reports a generic error instead of the hook's message.
- A hook that asks for user confirmation (`permissionDecision: "ask"`) blocks the tool call, because a plugin cannot open a prompt in opencode.
- A hook's `systemMessage` is passed to the model as a note. Claude Code shows it to the user instead.
- When a command is run with no arguments, `$1`-style placeholders are left untouched so that shell snippets such as `awk '{print $1}'` in a command body are not blanked. Claude Code blanks them.
- Marketplace names follow Claude Code's rules, including the names reserved for Anthropic's own marketplaces.

## Configuration

Options go in opencode's config, alongside the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/claude-4-opencode/dist",
      "options": {
        "pluginDirs": ["./my-plugin"], // load plugin directories directly, like claude --plugin-dir
        "disable": ["mcp", "hooks"], // turn off whole kinds: skills, commands, agents, mcp, hooks, bin
      },
    },
  ],
}
```

| Environment variable | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `C4O_HOME`           | Where marketplaces and plugins are stored. Default: `$XDG_DATA_HOME/opencode/claude-plugins` |
| `C4O_PLUGIN_DIRS`    | Extra plugin directories, separated like `PATH`                                              |
| `C4O_DISABLE`        | Comma-separated kinds to turn off                                                            |
| `C4O_LOG`            | File to write diagnostics to, including each hook's command, exit code and output            |

The store never touches `~/.claude`.

## What is tested

Every tier runs the real `opencode` binary in a throwaway home directory. Marketplaces are pinned to the commits in `e2e/targets.lock.json`, so a run is repeatable.

| Tier        | What it shows                                                                                                                                  | When it runs                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unit        | Parsing, translation and the hook protocol                                                                                                     | Every push and pull request                        |
| Conformance | Every entry of every pinned marketplace resolves and loads, and opencode lists every component                                                 | Every push and pull request                        |
| Golden      | Component names match what real Claude Code lists after installing the same plugins from the same commits                                      | Every push and pull request                        |
| Scripted    | A stub plays the model with scripted tool calls: skills load, commands render, agents run restricted, MCP tools answer, hooks block and inject | Every push and pull request                        |
| External    | Every plugin that lives outside its marketplace's repository is fetched at its pinned commit and loaded                                        | Nightly                                            |
| Live        | A real model drives the same plugins                                                                                                           | Nightly, when the `OPENCODE_API_KEY` secret is set |
| Drift       | Pins move to current commits, goldens are recaptured, and everything runs against the newest opencode                                          | Weekly                                             |

```sh
bun run test                 # unit
bun run e2e                  # conformance, golden and scripted, against the opencode on PATH
bun run e2e:report           # print the compatibility report from the last run
bun run e2e:oracle           # recapture golden files with your installed Claude Code

OPENCODE_API_KEY=... bun test ./e2e/live          # live tier
C4O_E2E_FULL=1 bun test ./e2e/conformance.test.ts # include external plugins
```

Set `OPENCODE_BIN` to test a different opencode build. Do not run a bare `bun test`: it would also pick up anything under `review/`.

The golden files come from real Claude Code, run in an empty config directory with a dummy API key, hooks disabled and plugin MCP servers ignored. It installs the plugins and prints its startup inventory; it makes no model request and runs no plugin code.

## Layout

```
src/spec/        reads Claude Code's plugin and marketplace formats
src/store/       marketplaces, installs, enabled state
src/translate/   turns a loaded plugin into opencode values, and reports what it could not
src/runtime/     the opencode plugin, including the hook engine
src/cli.ts       c4o
e2e/             sandbox, stub model, pinned targets, golden files, scenarios
docs/research/   prior art and what was learned about opencode v2's plugin API
```

## Background

[docs/research/prior-art.md](docs/research/prior-art.md) covers earlier projects in this space and how this one differs. [docs/research/opencode-v2-findings.md](docs/research/opencode-v2-findings.md) records how opencode v2's plugin API behaves in the places this project depends on.

The implementation is written from Claude Code's public documentation and checked against Claude Code's observable behavior. It contains no code from Claude Code or from reimplementations of it.
