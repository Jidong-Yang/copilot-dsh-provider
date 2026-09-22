import { expect, test } from "bun:test"
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { version } from "../package.json"

const root = resolve(import.meta.dir, "..")

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function checkServer(
  cwd: string,
  entry: string,
  expected: { version: string; revision: string } | null,
  noGit = false,
) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  const child = Bun.spawn([process.execPath, "--no-install", entry, "start"], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      COPILOT_DSH_HOME: join(cwd, "empty-credentials"),
      COPILOT_GITHUB_TOKEN: "",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ...(noGit ? { PATH: "", Path: "" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const reader = child.stdout.getReader()
    let output = ""
    while (!output.includes("Copilot model provider listening")) {
      const part = await reader.read()
      if (part.done) throw new Error(`Provider did not start: ${await new Response(child.stderr).text()}`)
      output += new TextDecoder().decode(part.value)
    }
    reader.releaseLock()
    const response = await fetch(`http://127.0.0.1:${port}/health/version`, {
      headers: { origin: "https://example.com" },
    })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.status).toBe(expected ? 200 : 503)
    expect(await response.json()).toEqual(expected ? {
      schemaVersion: 1,
      status: "ready",
      repository: "Jidong-Yang/copilot-dsh-provider",
      ...expected,
    } : {
      error: {
        message: "Provider build identity is unavailable.",
        type: "provider_error",
        code: "build-identity-unavailable",
      },
    })
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: "reauth-required" })
    expect((await fetch(`http://127.0.0.1:${port}/health/version`, { method: "POST" })).status).toBe(404)
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}

test("version health identifies clean source and standalone bundles, and refuses unverified source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-version-"))
  try {
    const source = join(directory, "source")
    const artifact = join(directory, "artifact")
    await mkdir(source)
    await mkdir(artifact)
    await cp(join(root, "src"), join(source, "src"), { recursive: true })
    await cp(join(root, "package.json"), join(source, "package.json"))
    git(source, "init")
    git(source, "add", ".")
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "Source fixture")
    const identity = { version, revision: git(source, "rev-parse", "HEAD") }
    await checkServer(source, join(source, "src", "main.ts"), identity)

    const build = Bun.spawnSync([
      process.execPath, "build", "src/main.ts", "--target=bun", "--packages=bundle",
      `--outdir=${artifact}`, `--metafile=${join(artifact, "meta.json")}`,
    ], { cwd: source })
    expect(build.exitCode).toBe(0)
    expect(git(source, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
    expect(build.stderr.toString()).not.toContain("identity unavailable")
    const bundle = join(artifact, "main.js")
    const bundledSource = await Bun.file(bundle).text()
    expect(bundledSource.includes(identity.revision)).toBe(true)
    expect(bundledSource.includes(directory)).toBe(false)
    expect(bundledSource.includes("spawnSync")).toBe(false)
    await rm(join(source, ".git"), { recursive: true, force: true })
    await checkServer(artifact, bundle, identity, true)
    await checkServer(source, join(source, "src", "main.ts"), null)

    // An enclosing repository must not be mistaken for this Provider's source.
    git(directory, "init")
    git(directory, "add", ".")
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "Unrelated enclosing repository")
    await checkServer(source, join(source, "src", "main.ts"), null)
    git(source, "init")
    git(source, "add", ".")
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "Source fixture")
    await checkServer(source, join(source, "src", "main.ts"), null, true)
    await writeFile(join(source, "untracked.ts"), "export const changed = true\n")
    await checkServer(source, join(source, "src", "main.ts"), null)
    await rm(join(source, "untracked.ts"))
    await writeFile(join(source, "src", "changed.ts"), "export const changed = true\n")
    git(source, "add", ".")
    await checkServer(source, join(source, "src", "main.ts"), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
