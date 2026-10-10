import { expect, test } from "bun:test"
import { parseArguments, renderCommand, substituteArguments } from "../src/translate/commands.ts"
import type { CommandDef } from "../src/spec/types.ts"

const context = {
  pluginRoot: "/plugins/demo",
  pluginData: "/data/demo",
  projectDir: "/project",
  userConfig: { region: "eu" },
}
const command = (body: string, frontmatter: Record<string, unknown> = {}): CommandDef => ({
  id: "demo:cmd",
  body,
  frontmatter,
})

test("arguments split like a shell, honoring quotes", () => {
  expect(parseArguments(`one "two words" 'three more' four`)).toEqual(["one", "two words", "three more", "four"])
  expect(parseArguments(`a "" b`)).toEqual(["a", "", "b"])
  expect(parseArguments("   ")).toEqual([])
})

test("$ARGUMENTS takes the whole string, indexed forms are 0-based", () => {
  expect(substituteArguments("All: $ARGUMENTS", "fix the bug")).toBe("All: fix the bug")
  expect(substituteArguments("$0 then $1 and $ARGUMENTS[2]", "a b c")).toBe("a then b and c")
  expect(substituteArguments("missing [$5]", "a")).toBe("missing []")
})

test("named arguments come from frontmatter order", () => {
  expect(substituteArguments("Deploy $service to $env", "api prod", ["service", "env"])).toBe("Deploy api to prod")
})

test("arguments are appended when the template has no placeholder", () => {
  expect(substituteArguments("Review the code.", "src/app.ts")).toBe("Review the code.\n\nARGUMENTS: src/app.ts")
  expect(substituteArguments("Review the code.", "")).toBe("Review the code.")
})

test("substituted text is not expanded a second time", () => {
  expect(substituteArguments("first=$0 all=$ARGUMENTS", "$1 real")).toBe("first=$1 all=$1 real")
})

test("with no arguments, shell snippets that use $1 survive and $ARGUMENTS is blanked", () => {
  const template = "Request: $ARGUMENTS\nRun: awk '{print $1}'"
  expect(substituteArguments(template, "")).toBe("Request: \nRun: awk '{print $1}'")
})

test("render substitutes plugin paths and user config", async () => {
  const text = await renderCommand(
    command('Run "${CLAUDE_PLUGIN_ROOT}/bin/tool" in ${CLAUDE_PROJECT_DIR} for ${user_config.region}'),
    "",
    context,
    { cwd: "/project", env: {} },
  )
  expect(text).toBe('Run "/plugins/demo/bin/tool" in /project for eu')
})

test("render replaces inline and fenced shell interpolation with command output", async () => {
  const seen: string[] = []
  const text = await renderCommand(
    command('Status: !`git status`\n\n```!\n"${CLAUDE_PLUGIN_ROOT}/setup.sh" $ARGUMENTS\n```\n\nDone.'),
    "--fast",
    context,
    {
      cwd: "/project",
      env: {},
      run: async (source, options) => {
        seen.push(source)
        expect(options.env.CLAUDE_PLUGIN_ROOT).toBe("/plugins/demo")
        return `<${source}>`
      },
    },
  )
  expect(seen).toEqual(["git status", `"/plugins/demo/setup.sh" '--fast'`])
  expect(text).toBe(`Status: <git status>\n\n<"/plugins/demo/setup.sh" '--fast'>\n\nDone.`)
})

test("an exclamation mark glued to a word is not shell interpolation", async () => {
  const text = await renderCommand(command("Wow!`not a command`"), "", context, {
    cwd: "/project",
    env: {},
    run: async () => "RAN",
  })
  expect(text).toBe("Wow!`not a command`")
})

test("named arguments accept the space-separated frontmatter form", async () => {
  const text = await renderCommand(
    command("Fix $issue on $branch", { arguments: "issue branch" }),
    "123 main",
    context,
    {
      cwd: "/project",
      env: {},
    },
  )
  expect(text).toBe("Fix 123 on main")
})

test("backslash escapes keep a single argument", () => {
  expect(parseArguments("file\\ name other")).toEqual(["file name", "other"])
  expect(parseArguments('"a\\"b" c')).toEqual(['a"b', "c"])
  expect(parseArguments("'a\\'b' c")).toEqual(["a'b", "c"])
})

test("argument text containing interpolation syntax is not executed", async () => {
  let ran = false
  const text = await renderCommand(command("Summarize: $ARGUMENTS"), "hello !`id` world", context, {
    cwd: "/project",
    env: {},
    run: async () => {
      ran = true
      return "RAN"
    },
  })
  expect(ran).toBe(false)
  expect(text).toBe("Summarize: hello !`id` world")
})

test("ARGUMENTS suffix appended after interpolation is not executed", async () => {
  const seen: string[] = []
  const text = await renderCommand(command("Status: !`git status`"), "hello !`id` world", context, {
    cwd: "/project",
    env: {},
    run: async (source) => {
      seen.push(source)
      return "ok"
    },
  })
  expect(seen).toEqual(["git status"])
  expect(text).toBe("Status: ok\n\nARGUMENTS: hello !`id` world")
})

test("arguments spliced into an existing interpolation are shell-quoted", async () => {
  const seen: string[] = []
  const text = await renderCommand(command("Output: !`echo $ARGUMENTS`"), "; rm -rf /", context, {
    cwd: "/project",
    env: {},
    run: async (source) => {
      seen.push(source)
      return `<${source}>`
    },
  })
  expect(seen).toEqual(["echo ';' 'rm' '-rf' '/'"])
  expect(text).toBe("Output: <echo ';' 'rm' '-rf' '/'>")
})
