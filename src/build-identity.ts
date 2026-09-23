import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

import { version } from "../package.json"

// Bun embeds the result in bundles; deployed artifacts need neither Git nor a checkout.
export function buildIdentity(): { version: string; revision: string } | null {
  const root = resolve(import.meta.dir, "..")
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  })
  const prefix = git("rev-parse", "--show-prefix")
  const head = git("rev-parse", "HEAD")
  const status = git("status", "--porcelain=v1", "--untracked-files=all")
  if (
    prefix.status !== 0 || head.status !== 0 || status.status !== 0
    || prefix.stdout.trim() !== ""
    || !/^[0-9a-f]{40}$/.test(head.stdout.trim())
    || status.stdout.trim() !== ""
  ) {
    console.error("Provider build identity unavailable: a clean Provider Git checkout is required.")
    return null
  }
  return { version, revision: head.stdout.trim() }
}
