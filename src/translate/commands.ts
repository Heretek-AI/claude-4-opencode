import { execFile } from "node:child_process"
import { asStringList } from "../spec/frontmatter.ts"
import type { CommandDef } from "../spec/types.ts"
import { pluginEnvironment, substitute, type VarContext } from "./vars.ts"

/** Splits an argument string the way a shell would, honoring single and double quotes. */
export function parseArguments(input: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      // Backslash escapes the quote character and backslash itself inside quotes.
      if (char === "\\" && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === "\\")) {
        current += input[i + 1]!
        i++
        started = true
        continue
      }
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    // Outside quotes a backslash escapes the next character (e.g. `file\ name`).
    if (char === "\\" && i + 1 < input.length) {
      current += input[i + 1]!
      i++
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current !== "") result.push(current)
      current = ""
      started = false
      continue
    }
    current += char
  }
  if (started || current !== "") result.push(current)
  return result
}

/** Shell-quotes a single value so it can be spliced safely into `bash -c` text. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function replacePlaceholders(
  template: string,
  args: string[],
  input: string,
  names: string[],
  quote: boolean,
): { text: string; found: boolean } {
  const named = new Map(names.map((name, index) => [name, index]))
  const positional = args.length === 0 ? "" : "|\\$(\\d+)(?!\\w)"
  const namePattern =
    names.length === 0 || args.length === 0 ? "" : `|\\$(${names.map(escapeRegExp).join("|")})(?![\\[\\w])`
  // One pass, so argument text that itself contains a placeholder is never expanded again.
  const pattern = new RegExp(`\\$ARGUMENTS\\[(\\d+)\\]|\\$ARGUMENTS${positional}${namePattern}`, "g")
  let found = false
  const text = template.replace(pattern, (whole, indexed?: string, shorthand?: string, name?: string) => {
    found = true
    if (whole === "$ARGUMENTS") {
      if (!quote) return input
      return args.length === 0 ? "" : args.map(shellQuote).join(" ")
    }
    const index =
      indexed !== undefined ? Number(indexed) : shorthand !== undefined ? Number(shorthand) : named.get(name!)!
    const value = args[index] ?? ""
    if (!quote) return value
    return args[index] === undefined ? "" : shellQuote(value)
  })
  return { text, found }
}

/**
 * Fills `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (both 0-based) and named arguments declared in the
 * `arguments` frontmatter. A template with no placeholder gets the arguments appended.
 *
 * One deliberate difference from Claude Code: when the command is invoked with no arguments,
 * `$N` and named placeholders are left alone. Command bodies often embed shell such as
 * `awk '{print $1}'`, and blanking those would corrupt the instructions.
 */
export function substituteArguments(template: string, input: string, names: string[] = []): string {
  const args = parseArguments(input)
  const { text: result, found } = replacePlaceholders(template, args, input, names, false)
  return found || input.trim() === "" ? result : `${result}\n\nARGUMENTS: ${input}`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface Interpolation {
  start: number
  end: number
  source: string
}

/**
 * Finds the two documented forms of shell interpolation: a fenced code block whose info string
 * is `!`, and inline `` !`command` `` at the start of the text or after whitespace.
 */
function findInterpolations(text: string): Interpolation[] {
  const found: Interpolation[] = []
  for (const match of text.matchAll(/^[ \t]*```![ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm))
    found.push({ start: match.index, end: match.index + match[0].length, source: match[1]! })
  const fenced = [...found]
  for (const match of text.matchAll(/(^|\s)!`([^`\r\n]+)`/g)) {
    const start = match.index + match[1]!.length
    if (fenced.some((block) => start >= block.start && start < block.end)) continue
    found.push({ start, end: match.index + match[0].length, source: match[2]! })
  }
  return found.toSorted((a, b) => a.start - b.start)
}

export interface RenderOptions {
  cwd: string
  env: Record<string, string | undefined>
  /** Runs one shell interpolation. Replaceable so tests need no real shell. */
  run?: (command: string, options: { cwd: string; env: Record<string, string | undefined> }) => Promise<string>
}

/**
 * Renders a command body into the prompt text: path variables, then shell interpolation
 * detection (before argument substitution, so user input can never inject `!`...``),
 * then arguments (raw in prose, shell-quoted inside interpolations), whose output
 * replaces the placeholder as it does in Claude Code. The `ARGUMENTS:` suffix is
 * appended after splicing outputs so it is never scanned for interpolation.
 */
export async function renderCommand(
  command: CommandDef,
  input: string,
  context: VarContext,
  options: RenderOptions,
): Promise<string> {
  const names = asStringList(command.frontmatter.arguments) ?? []
  const argumentNames = names.length === 1 ? names[0]!.split(/\s+/).filter(Boolean) : names
  const base = substitute(command.body, context)
  const interpolations = findInterpolations(base)
  if (interpolations.length === 0) return substituteArguments(base, input, argumentNames).trim()
  const args = parseArguments(input)
  let found = false
  const textParts: string[] = []
  const shellSources: string[] = []
  let cursor = 0
  for (const item of interpolations) {
    const head = replacePlaceholders(base.slice(cursor, item.start), args, input, argumentNames, false)
    found ||= head.found
    textParts.push(head.text)
    const source = replacePlaceholders(item.source, args, input, argumentNames, true)
    found ||= source.found
    shellSources.push(source.text)
    cursor = item.end
  }
  const tail = replacePlaceholders(base.slice(cursor), args, input, argumentNames, false)
  found ||= tail.found
  textParts.push(tail.text)
  const run = options.run ?? runShell
  const env = { ...options.env, ...pluginEnvironment(context) }
  const outputs = await Promise.all(shellSources.map((source) => run(source, { cwd: options.cwd, env })))
  let result = ""
  for (const [index, output] of outputs.entries()) result += textParts[index]! + output
  result += textParts[textParts.length - 1]!
  if (!found && input.trim() !== "") result += `\n\nARGUMENTS: ${input}`
  return result.trim()
}

function runShell(command: string, options: { cwd: string; env: Record<string, string | undefined> }): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      // A failing interpolation still yields text for the model, as it does in Claude Code.
      (error, stdout, stderr) =>
        resolve((stdout + stderr).trimEnd() || (error ? `[command failed: ${error.message}]` : "")),
    )
  })
}
