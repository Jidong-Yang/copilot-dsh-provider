import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { GITHUB_CLIENT_ID, TOKEN_PATH } from "./config.ts"
import {
  ProviderRequestError,
  validRetryAfter,
} from "./errors.ts"
import type { ProviderErrorOptions } from "./errors.ts"

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface AccessTokenReply {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

interface StoredCredential {
  version: 1
  accessToken: string
  expiresAt?: number
  refreshToken?: string
  refreshTokenExpiresAt?: number
}

const EXPIRY_SKEW_MS = 60_000
const pendingRefreshes = new Map<string, Promise<string>>()

export class GitHubCredentialUnavailableError extends ProviderRequestError {
  public constructor(message: string, options?: ProviderErrorOptions) {
    super(message, { ...options, failureCode: "upstream-unavailable" })
  }
}

export async function readGitHubToken(forceRefresh = false): Promise<string> {
  const environmentToken = process.env["COPILOT_GITHUB_TOKEN"]
  if (environmentToken?.trim()) return environmentToken.trim()
  return await readGitHubTokenFrom(TOKEN_PATH, forceRefresh)
}

export async function readGitHubTokenFrom(
  path: string,
  forceRefresh = false,
): Promise<string> {
  const stored = await readStoredCredential(path)
  if (typeof stored === "string") return stored
  if (!forceRefresh && (
    stored.expiresAt === undefined
    || Date.now() < stored.expiresAt - EXPIRY_SKEW_MS
  )) return stored.accessToken
  if (!stored.refreshToken) {
    throw new Error(`GitHub credential expired; run "bun run auth"`)
  }
  if (
    stored.refreshTokenExpiresAt !== undefined
    && Date.now() >= stored.refreshTokenExpiresAt - EXPIRY_SKEW_MS
  ) {
    throw new Error(`GitHub refresh credential expired; run "bun run auth"`)
  }

  const existing = pendingRefreshes.get(path)
  if (existing) return await existing
  const pending = refreshStoredCredential(path, stored)
  pendingRefreshes.set(path, pending)
  try {
    return await pending
  } finally {
    if (pendingRefreshes.get(path) === pending) pendingRefreshes.delete(path)
  }
}

export async function authenticate(): Promise<void> {
  const device = await requestDeviceCode()
  console.log(`Open ${device.verification_uri} and enter code ${device.user_code}`)
  const reply = await pollAccessToken(device)
  await writeStoredCredential(TOKEN_PATH, credentialFromReply(reply))
  console.log(`Authentication saved to ${TOKEN_PATH}`)
}

async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user offline_access",
    }),
  })
  if (!response.ok) throw await httpError("Device authentication failed", response)
  return await response.json() as DeviceCode
}

async function pollAccessToken(device: DeviceCode): Promise<AccessTokenReply> {
  const deadline = Date.now() + device.expires_in * 1000
  let interval = device.interval * 1000
  while (Date.now() < deadline) {
    await Bun.sleep(interval)
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    if (!response.ok) {
      if ([429, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel()
        continue
      }
      throw await httpError("Token polling failed", response)
    }
    const reply = await response.json() as AccessTokenReply
    if (reply.access_token) return reply
    if (reply.error === "slow_down") interval += 5000
    else if (reply.error !== "authorization_pending") {
      throw new Error(reply.error_description ?? reply.error ?? "Authentication failed")
    }
  }
  throw new Error("Device authentication expired")
}

async function httpError(message: string, response: Response): Promise<Error> {
  return new Error(`${message} (${response.status}): ${await response.text()}`)
}

async function readStoredCredential(path: string): Promise<StoredCredential | string> {
  const content = (await readFile(path, "utf8")).trim()
  if (!content) throw new Error(`No GitHub token found; run "bun run auth"`)
  if (!content.startsWith("{")) return content

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error(`Invalid GitHub credential; run "bun run auth"`)
  }
  if (!isStoredCredential(value)) {
    throw new Error(`Invalid GitHub credential; run "bun run auth"`)
  }
  return value
}

async function refreshStoredCredential(
  path: string,
  stored: StoredCredential,
): Promise<string> {
  let response: Response
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    })
  } catch (error) {
    throw new GitHubCredentialUnavailableError("GitHub token refresh request failed", {
      cause: error,
    })
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = validRetryAfter(response)
      await response.body?.cancel()
      throw new GitHubCredentialUnavailableError(
        `GitHub token refresh failed (${response.status})`,
        { retryAfter },
      )
    }
    throw new Error(`GitHub token refresh rejected (${response.status}); run "bun run auth"`)
  }
  let reply: AccessTokenReply
  try {
    reply = await response.json() as AccessTokenReply
  } catch (error) {
    throw new GitHubCredentialUnavailableError(
      "GitHub token refresh returned an invalid response",
      { cause: error },
    )
  }
  if (!reply.access_token || !reply.refresh_token) {
    if (reply.error) {
      throw new Error(reply.error_description ?? reply.error)
    }
    throw new GitHubCredentialUnavailableError(
      "GitHub token refresh returned an invalid credential",
    )
  }
  const credential = credentialFromReply(reply)
  await writeStoredCredential(path, credential)
  return credential.accessToken
}

function credentialFromReply(reply: AccessTokenReply): StoredCredential {
  if (!reply.access_token) throw new Error("GitHub authentication returned no access token")
  const now = Date.now()
  return {
    version: 1,
    accessToken: reply.access_token,
    ...(reply.expires_in === undefined
      ? {}
      : { expiresAt: now + reply.expires_in * 1000 }),
    ...(reply.refresh_token === undefined
      ? {}
      : { refreshToken: reply.refresh_token }),
    ...(reply.refresh_token_expires_in === undefined
      ? {}
      : { refreshTokenExpiresAt: now + reply.refresh_token_expires_in * 1000 }),
  }
}

async function writeStoredCredential(
  path: string,
  credential: StoredCredential,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(credential, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item["version"] === 1
    && typeof item["accessToken"] === "string"
    && item["accessToken"].length > 0
    && isOptionalNumber(item["expiresAt"])
    && isOptionalString(item["refreshToken"])
    && isOptionalNumber(item["refreshTokenExpiresAt"])
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0)
}
