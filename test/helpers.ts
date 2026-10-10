import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Creates a temporary directory holding the given files. Keys are relative paths; objects are written as JSON. */
export function tree(files: Record<string, string | object>): string {
  const root = mkdtempSync(path.join(tmpdir(), "c4o-test-"))
  write(root, files)
  return root
}

export function write(root: string, files: Record<string, string | object>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content, null, 2))
  }
}

export const skill = (description: string, body = "Skill body.") => `---\ndescription: ${description}\n---\n\n${body}\n`
