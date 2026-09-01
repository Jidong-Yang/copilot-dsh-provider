import { afterEach, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readGitHubTokenFrom } from "../src/auth.ts"
import { GITHUB_CLIENT_ID } from "../src/config.ts"

const originalFetch = globalThis.fetch
const temporaryDirectories: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

test("reads legacy plain-text GitHub credentials", async () => {
  const path = await credentialPath()
  await writeFile(path, "legacy-token\n")

  expect(await readGitHubTokenFrom(path)).toBe("legacy-token")
})

test("refreshes an expired GitHub credential and persists the rotated pair", async () => {
  const path = await credentialPath()
  await writeFile(path, JSON.stringify({
    version: 1,
    accessToken: "expired-access",
    expiresAt: Date.now() - 1000,
    refreshToken: "old-refresh",
    refreshTokenExpiresAt: Date.now() + 3_600_000,
  }))
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: GITHUB_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    })
    return Promise.resolve(Response.json({
      access_token: "new-access",
      expires_in: 28_800,
      refresh_token: "new-refresh",
      refresh_token_expires_in: 15_552_000,
    }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  expect(await readGitHubTokenFrom(path)).toBe("new-access")
  const stored = JSON.parse(await readFile(path, "utf8"))
  expect(stored).toMatchObject({
    version: 1,
    accessToken: "new-access",
    refreshToken: "new-refresh",
  })
  expect(stored.expiresAt).toBeGreaterThan(Date.now())
  expect(stored.refreshTokenExpiresAt).toBeGreaterThan(stored.expiresAt)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("coalesces concurrent refreshes because refresh tokens are single-use", async () => {
  const path = await credentialPath()
  await writeFile(path, JSON.stringify({
    version: 1,
    accessToken: "expired-access",
    expiresAt: Date.now() - 1000,
    refreshToken: "single-use-refresh",
  }))
  const fetchMock = mock(async () => {
    await Bun.sleep(10)
    return Response.json({
      access_token: "new-access",
      expires_in: 28_800,
      refresh_token: "new-refresh",
      refresh_token_expires_in: 15_552_000,
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  expect(await Promise.all([
    readGitHubTokenFrom(path),
    readGitHubTokenFrom(path),
  ])).toEqual(["new-access", "new-access"])
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("requires authentication when the refresh credential has expired", async () => {
  const path = await credentialPath()
  await writeFile(path, JSON.stringify({
    version: 1,
    accessToken: "expired-access",
    expiresAt: Date.now() - 1000,
    refreshToken: "expired-refresh",
    refreshTokenExpiresAt: Date.now() - 1000,
  }))

  await expect(readGitHubTokenFrom(path)).rejects.toThrow(
    'GitHub refresh credential expired; run "bun run auth"',
  )
})

test("reports an unavailable upstream for a malformed refresh response", async () => {
  const path = await credentialPath()
  await writeFile(path, JSON.stringify({
    version: 1,
    accessToken: "expired-access",
    expiresAt: Date.now() - 1000,
    refreshToken: "refresh-token",
  }))
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("not-json"))) as unknown as typeof fetch

  await expect(readGitHubTokenFrom(path)).rejects.toMatchObject({
    name: "Error",
    message: "GitHub token refresh returned an invalid response",
  })
})

test("retains only a valid Retry-After value from a transient refresh failure", async () => {
  const path = await credentialPath()
  await writeFile(path, JSON.stringify({
    version: 1,
    accessToken: "expired-access",
    expiresAt: Date.now() - 1000,
    refreshToken: "refresh-token",
  }))
  globalThis.fetch = mock(() => Promise.resolve(new Response("private failure body", {
    status: 503,
    headers: {
      "retry-after": "41",
      "x-private-header": "private-value",
    },
  }))) as unknown as typeof fetch

  await expect(readGitHubTokenFrom(path)).rejects.toMatchObject({
    message: "GitHub token refresh failed (503)",
    retryAfter: "41",
  })
})

async function credentialPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "copilot-dsh-auth-"))
  temporaryDirectories.push(directory)
  return join(directory, "github-token")
}
