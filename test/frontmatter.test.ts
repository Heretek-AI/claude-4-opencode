import { expect, test } from "bun:test"
import { asStringList, parseMarkdown } from "../src/spec/frontmatter.ts"

test("splits frontmatter from the body", () => {
  const result = parseMarkdown("---\nname: demo\ndescription: A demo\n---\n\n# Title\n")
  expect(result.data).toEqual({ name: "demo", description: "A demo" })
  expect(result.body).toBe("\n# Title\n")
})

test("a file with no frontmatter is all body", () => {
  expect(parseMarkdown("# Just text\n")).toEqual({ data: {}, body: "# Just text\n" })
})

test("empty frontmatter yields no data", () => {
  expect(parseMarkdown("---\n---\nbody")).toEqual({ data: {}, body: "body" })
})

test("falls back to line parsing when the YAML is invalid", () => {
  // An unquoted value containing ": " is not valid YAML, but plugin authors write it anyway.
  const result = parseMarkdown("---\ndescription: Use when: the user asks\nmodel: sonnet\n---\nbody")
  expect(result.data).toEqual({ description: "Use when: the user asks", model: "sonnet" })
})

test("tool lists split on commas outside parentheses", () => {
  expect(asStringList("Bash(git add:*, git status:*), Read, Grep")).toEqual([
    "Bash(git add:*, git status:*)",
    "Read",
    "Grep",
  ])
  expect(asStringList(["Read", "Edit"])).toEqual(["Read", "Edit"])
})
