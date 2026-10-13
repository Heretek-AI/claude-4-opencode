import { expect, test } from "bun:test"
import { substitute, substituteWithEnv, type VarContext } from "../src/translate/vars.ts"

const context: VarContext = {
  pluginRoot: "/root",
  pluginData: "/data",
  projectDir: "/project",
  userConfig: { TOKEN: "abc" },
}

// WS6 invariant I-1: opencode-native `{env:VAR}` is never expanded here and
// never emitted — it passes through byte-identical.
test("opencode {env:VAR} passes through byte-identical", () => {
  expect(substitute("{env:FOO}", context)).toBe("{env:FOO}")
  expect(substitute("prefix {env:FOO} suffix", context)).toBe("prefix {env:FOO} suffix")
  expect(substituteWithEnv("{env:FOO}", context, { FOO: "x" })).toBe("{env:FOO}")
  expect(substituteWithEnv("Bearer {env:TOKEN}", context, { TOKEN: "x" })).toBe("Bearer {env:TOKEN}")
})

// I-2: `substitute` has no env — `${FOO}` stays literal without an env pass.
test("substitute leaves bare ${VAR} literal", () => {
  expect(substitute("key=${FOO}", context)).toBe("key=${FOO}")
})

// I-3/I-7: `substituteWithEnv` expands from the explicit env param with
// `${VAR:-default}` fallback; missing stays literal.
test("substituteWithEnv expands ${VAR} and ${VAR:-default}, missing stays literal", () => {
  expect(substituteWithEnv("key=${FOO}", context, { FOO: "x" })).toBe("key=x")
  expect(substituteWithEnv("key=${MISSING:-def}", context, {})).toBe("key=def")
  expect(substituteWithEnv("key=${MISSING}", context, {})).toBe("key=${MISSING}")
})

// I-7: single pass, no recursion — userConfig values are inserted literally.
test("userConfig values are inserted literally without re-expansion", () => {
  const nested: VarContext = {
    ...context,
    userConfig: { NEST: "${CLAUDE_PLUGIN_ROOT}/x" },
  }
  expect(substitute("${user_config.NEST}", nested)).toBe("${CLAUDE_PLUGIN_ROOT}/x")
})
