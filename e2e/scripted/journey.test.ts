import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { REPO } from "../lib/repo.ts"
import { Sandbox } from "../lib/sandbox.ts"

/** The path a new user takes, start to finish, using only the CLI and a running opencode. */
test("setup, add a marketplace, then install, disable and uninstall while opencode keeps running", async () => {
  await using sandbox = new Sandbox({ unregistered: true })
  const id = "frontend-design:frontend-design"

  // `c4o setup` is what puts the plugin into opencode's own config.
  const setup = await sandbox.c4oJson<{ config: string; changed: boolean }>("setup")
  expect(setup.changed).toBe(true)
  expect(readFileSync(setup.config, "utf8")).toContain(path.join(REPO, "dist"))
  expect((await sandbox.c4o("doctor")).stdout).not.toContain("FAIL")

  await sandbox.addMarketplace("claude-plugins-official")
  const server = await sandbox.serve()
  expect((await server.inventory()).skills).not.toContain(id)

  // No restart between these steps: the running plugin watches the store.
  await sandbox.c4o("install", "frontend-design")
  await server.waitForInventory((inventory) => inventory.skills.includes(id) && inventory.commands.includes(id), 30_000)

  await sandbox.c4o("disable", "frontend-design")
  await server.waitForInventory((inventory) => !inventory.skills.includes(id), 30_000)

  await sandbox.c4o("enable", "frontend-design")
  await server.waitForInventory((inventory) => inventory.skills.includes(id), 30_000)

  await sandbox.c4o("uninstall", "frontend-design")
  const after = await server.waitForInventory((inventory) => !inventory.skills.includes(id), 30_000)
  expect(after.commands).not.toContain(id)
  expect((await sandbox.c4o("list")).stdout).toContain("No plugins installed")
}, 240_000)
