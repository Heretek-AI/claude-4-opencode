import { expect, test } from "bun:test"
import path from "node:path"
import { dataDirectory, encodeDataName, storePaths } from "../src/store/paths.ts"
import { encodeMcpPart, mcpServerName } from "../src/translate/components.ts"
import { tree } from "./helpers.ts"

const allowed = /^[A-Za-z0-9_-]*$/

test("dataDirectory encoding is collision-free for the old `-` collapse", () => {
  const paths = storePaths({ C4O_HOME: tree({}) })
  // Old code mapped all three to the same directory.
  const a = dataDirectory(paths, "foo.bar@market")
  const b = dataDirectory(paths, "foo-bar@market")
  const c = dataDirectory(paths, "foo@bar-market")
  expect(new Set([a, b, c]).size).toBe(3)
  for (const dir of [a, b, c]) expect(path.basename(dir)).toMatch(allowed)
})

test("dataDirectory encoding keeps `-` and `-hex-` sequences distinct", () => {
  // `-` becomes `--`, so a literal `-2e-` cannot collide with the encoding of `.`.
  const names = ["a.b", "a-2e-b", "a-b", "a--b", "a_b", "a@b", "a-b@c.d"]
  const encoded = names.map(encodeDataName)
  expect(new Set(encoded).size).toBe(names.length)
  for (const name of encoded) expect(name).toMatch(allowed)
  // Alphanumerics and `_` pass through; `-` doubles.
  expect(encodeDataName("abc_XYZ-012")).toBe("abc_XYZ--012")
  expect(encodeDataName(".")).toBe("-2e-")
  expect(encodeDataName("@")).toBe("-40-")
})

test("mcpServerName stays in [A-Za-z0-9_-] and is collision-free", () => {
  // Old lossy clean mapped `a.b` and `a-b` to the same part.
  expect(encodeMcpPart("a.b")).not.toBe(encodeMcpPart("a-b"))
  expect(mcpServerName("my.plugin", "srv")).not.toBe(mcpServerName("my-plugin", "srv"))
  for (const name of [
    mcpServerName("my.plugin", "srv"),
    mcpServerName("my-plugin", "srv"),
    mcpServerName("p", "s.v"),
    mcpServerName("p", "s-v"),
  ])
    expect(name).toMatch(allowed)
  expect(mcpServerName("p", "s.v")).not.toContain(".")
})

test("mcpServerName keeps the plugin/server boundary unambiguous", () => {
  // Old code joined cleaned parts with `_`, so these two collided as `a_b_c`.
  const first = mcpServerName("a_b", "c")
  const second = mcpServerName("a", "b_c")
  expect(first).not.toBe(second)
  // `_` in a part is escaped, so a bare `_` only ever marks the boundary.
  expect(encodeMcpPart("a_b")).not.toContain("_")
  expect(encodeMcpPart("a-b")).toContain("--")
  expect(first.split("_")).toHaveLength(2)
  expect(second.split("_")).toHaveLength(2)
  // The single form (plugin === server) has no separator and cannot collide with a pair.
  const single = mcpServerName("x", "x")
  const pair = mcpServerName("x", "y")
  expect(single).not.toContain("_")
  expect(pair).toContain("_")
  expect(single).not.toBe(pair)
})
