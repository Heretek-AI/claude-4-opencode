import { parse } from "yaml"

export interface Markdown {
  data: Record<string, unknown>
  body: string
}

const FENCE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

export function parseMarkdown(text: string): Markdown {
  const source = text.replace(/^﻿/, "")
  const match = FENCE.exec(source)
  if (!match) return { data: {}, body: source }
  return { data: parseFrontmatter(match[1] ?? ""), body: source.slice(match[0].length) }
}

function parseFrontmatter(source: string): Record<string, unknown> {
  try {
    const value: unknown = parse(source)
    if (isRecord(value)) return value
    if (value === null || value === undefined) return {}
  } catch {
    // Plugin authors routinely write values YAML rejects, such as an unquoted
    // description containing ": ". Claude Code still loads those files.
  }
  return parseLoose(source)
}

function parseLoose(source: string): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const raw = match[2]!.trim()
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    data[match[1]!] = quoted ? quoted[2] : raw
  }
  return data
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

/** Accepts a YAML list or the comma-separated string form that `tools:` and `allowed-tools:` use. */
export function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(asString).filter((item): item is string => item !== undefined)
  if (typeof value !== "string") return undefined
  const items: string[] = []
  let depth = 0
  let current = ""
  for (const char of value) {
    if (char === "(") depth++
    if (char === ")") depth = Math.max(0, depth - 1)
    // Commas inside `Bash(git add:*, git status:*)` belong to the rule, not the list.
    if (char === "," && depth === 0) {
      items.push(current)
      current = ""
      continue
    }
    current += char
  }
  items.push(current)
  return items.map((item) => item.trim()).filter((item) => item !== "")
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}
