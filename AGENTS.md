# AGENTS.md

## Evidence

Back every claim about behavior with something executed or read: test output, command output, a file and line. State what was not run.

## Clean room

The implementation is written from Claude Code's public documentation and checked against Claude Code's observable behavior. Take behavior from the docs or from running `claude`, and say which. Code from Claude Code, or from reimplementations of it, stays out of this repository; `review/` holds third-party reference source for reading and is gitignored.

## Canonical surfaces

- Generated files, regenerated and never hand-edited:
  - `COMPATIBILITY.md`: `bun run e2e`, then `bun run e2e:report`.
  - `e2e/golden/`: `bun run e2e:oracle`, which needs Claude Code installed.
  - `e2e/targets.lock.json`: `bun e2e/drift.ts`. The weekly Drift workflow moves these pins and opens the pull request.
- The opencode version is spelled in four places that move together: `@opencode/plugin` in `package.json`, the matrix in `.github/workflows/e2e.yml`, and two installs in `.github/workflows/nightly.yml`. Dependabot ignores `@opencode/*` for that reason.
- `docs/research/opencode-v2-findings.md` records how the opencode v2 plugin API behaves where this project depends on it. Read it before changing `src/runtime/`, and update it when an observation changes.

## Commands

- `bun run test`, never a bare `bun test`: the bare form also collects anything under `review/`.
- `bun run e2e` drives the real `opencode` binary on `PATH` in a throwaway home directory. `OPENCODE_BIN` selects another build.
- `bun run format` after editing any file, Markdown and YAML included: CI runs `format:check` across the repository.
- The live tier (`bun test ./e2e/live`) needs `OPENCODE_API_KEY` and spends. Run it only when asked.

## Workflow

- Work on a topic branch and open a pull request. A maintainer merges.
- A `v*` tag publishes to npm through `.github/workflows/release.yml`. Pushing one is a maintainer's step.
- Stage explicit paths.
- After a push, check every workflow run.
- Write repo-relative paths in tracked files, and `owner/name` for another repository.
