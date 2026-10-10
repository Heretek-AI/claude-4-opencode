import { appendFileSync } from "node:fs"

/**
 * Diagnostics go to the file named by `C4O_LOG`, never to stdout: opencode's stdio server mode
 * uses stdout as its protocol channel.
 */
export function debug(message: string, detail?: Record<string, unknown>) {
  const file = process.env.C4O_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), message, ...detail }) + "\n")
  } catch {
    // A broken log path must not take the plugin down.
  }
}
