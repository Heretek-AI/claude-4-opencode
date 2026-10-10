import type { Plugin } from "@opencode/plugin"
import { mkdirSync, watch } from "node:fs"
import path from "node:path"
import { asBoolean } from "../spec/frontmatter.ts"
import type { CommandDef } from "../spec/types.ts"
import { loadActivePlugins, type ActivePlugin } from "../store/installs.ts"
import { storePaths } from "../store/paths.ts"
import { renderCommand } from "../translate/commands.ts"
import { mcpServerName, toAgent, toMcp, toSkill, varContext } from "../translate/components.ts"
import { debug } from "./debug.ts"
import { bindHooks } from "./hooks/bind.ts"

type Context = Plugin.Context
type Editor<Domain extends "skill" | "command" | "agent" | "mcp"> = Parameters<
  Parameters<Context[Domain]["transform"]>[0]
>[0]

/**
 * opencode's schema types are branded (`Skill.ID`, `AbsolutePath`, ...). The translate layer
 * produces the same shapes as plain values, so they are cast once here at the boundary.
 */
const branded = <Target>(value: unknown) => value as Target

const plugin: Plugin.Plugin = {
  id: "claude-4-opencode",
  setup: async (ctx) => {
    const paths = storePaths()
    const projectDir = ctx.location.directory
    const pluginDirs = [
      ...stringList(ctx.options.pluginDirs),
      ...(process.env.C4O_PLUGIN_DIRS?.split(path.delimiter).filter(Boolean) ?? []),
    ].map((directory) => path.resolve(projectDir, directory))
    // `disable` turns off translation of whole component kinds, e.g. ["mcp", "hooks"].
    const disabled = new Set([
      ...stringList(ctx.options.disable),
      ...(process.env.C4O_DISABLE?.split(",").filter(Boolean) ?? []),
    ])
    const load = () =>
      loadActivePlugins(paths, { pluginDirs }).map((active) => {
        // Plugins expect ${CLAUDE_PLUGIN_DATA} to exist by the time they use it.
        mkdirSync(active.dataDir, { recursive: true })
        return withoutDisabled(active)
      })
    const withoutDisabled = (active: ActivePlugin): ActivePlugin => ({
      ...active,
      plugin: {
        ...active.plugin,
        ...(disabled.has("skills") ? { skills: [] } : {}),
        ...(disabled.has("commands") ? { commands: [] } : {}),
        ...(disabled.has("agents") ? { agents: [] } : {}),
        ...(disabled.has("mcp") ? { mcpServers: {} } : {}),
        ...(disabled.has("hooks") ? { hooks: {} } : {}),
        ...(disabled.has("bin") ? { binDir: undefined } : {}),
      },
    })
    const state = { plugins: load() }
    debug("setup", { store: paths.root, projectDir, plugins: state.plugins.map((item) => item.id) })

    /** PATH with each enabled plugin's bin/ in front, as Claude Code arranges for the Bash tool. */
    const pathWithBins = (current: string | undefined) => {
      const bins = state.plugins.flatMap((active) => (active.plugin.binDir === undefined ? [] : [active.plugin.binDir]))
      return bins.length === 0 ? current : [...bins, current ?? ""].join(path.delimiter)
    }

    await ctx.skill.transform((editor) => {
      for (const active of state.plugins) {
        const context = varContext(active, projectDir)
        for (const skill of active.plugin.skills)
          editor.add(branded<Parameters<Editor<"skill">["add"]>[0]>(toSkill(skill, context)))
      }
    })

    await ctx.command.transform((editor) => {
      for (const active of state.plugins) {
        const ids = new Set(active.plugin.commands.map((command) => command.id))
        // Claude Code also lets the user run a skill as `/plugin:skill args`.
        const skills = active.plugin.skills
          .filter((skill) => !ids.has(skill.id) && asBoolean(skill.frontmatter["user-invocable"]) !== false)
          .map((skill): CommandDef => ({
            id: skill.id,
            ...(skill.description === undefined ? {} : { description: skill.description }),
            body: `Base directory for this skill: ${path.dirname(skill.path)}\n\n${skill.body}`,
            frontmatter: skill.frontmatter,
          }))
        for (const command of [...active.plugin.commands, ...skills]) {
          editor.add({
            name: command.id,
            ...(command.description === undefined ? {} : { description: command.description }),
            execute: async (input) => {
              const text = await renderCommand(command, input.prompt.text, varContext(active, projectDir), {
                cwd: projectDir,
                // Scripts run from a command body identify their session this way in Claude Code.
                env: { ...process.env, PATH: pathWithBins(process.env.PATH), CLAUDE_CODE_SESSION_ID: input.sessionID },
              })
              await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery })
            },
          })
        }
      }
    })

    await ctx.agent.transform((editor) => {
      for (const active of state.plugins) {
        const context = varContext(active, projectDir)
        for (const agent of active.plugin.agents) {
          const translated = toAgent(agent, context)
          editor.update(translated.id, (item) => {
            if (translated.description !== undefined) item.description = translated.description
            item.system = translated.system
            item.mode = translated.mode
            if (translated.color !== undefined) item.color = translated.color
            item.permissions.push(...translated.permissions)
          })
        }
      }
    })

    await ctx.mcp.transform((editor) => {
      for (const active of state.plugins) {
        const context = varContext(active, projectDir)
        for (const [name, server] of Object.entries(active.plugin.mcpServers))
          editor.set(
            mcpServerName(active.plugin.name, name),
            branded<Parameters<Editor<"mcp">["set"]>[1]>(toMcp(server, context, process.env)),
          )
      }
    })

    const shell = await ctx.shell.hook("create.before", (event) => {
      event.env.PATH = pathWithBins(event.env.PATH ?? process.env.PATH)
    })

    const unbindHooks = await bindHooks(ctx, state, { projectDir, transcripts: path.join(paths.root, "transcripts") })

    // `c4o install`, `enable` and friends rewrite the store's state files. Pick the change up
    // without restarting opencode.
    let timer: ReturnType<typeof setTimeout> | undefined
    const reload = async () => {
      state.plugins = load()
      debug("reload", { plugins: state.plugins.map((item) => item.id) })
      await Promise.all([ctx.skill.reload(), ctx.command.reload(), ctx.agent.reload(), ctx.mcp.reload()])
    }
    mkdirSync(paths.root, { recursive: true })
    const watcher = watch(paths.root, () => {
      clearTimeout(timer)
      timer = setTimeout(() => void reload().catch((error) => debug("reload failed", { error: String(error) })), 150)
    })

    return () => {
      clearTimeout(timer)
      watcher.close()
      unbindHooks()
      void shell.dispose()
    }
  },
}

export default plugin

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
