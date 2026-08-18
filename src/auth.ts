import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { GITHUB_CLIENT_ID, TOKEN_PATH } from "./config.ts"

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface AccessTokenReply {
  access_token?: string
  error?: string
  error_description?: string
}

export async function readGitHubToken(): Promise<string> {
  const environmentToken = process.env["COPILOT_GITHUB_TOKEN"]
  if (environmentToken?.trim()) return environmentToken.trim()
  const storedToken = (await readFile(TOKEN_PATH, "utf8")).trim()
  if (!storedToken) throw new Error(`No GitHub token found; run "bun run auth"`)
  return storedToken
}

export async function authenticate(): Promise<void> {
  const device = await requestDeviceCode()
  console.log(`Open ${device.verification_uri} and enter code ${device.user_code}`)
  const token = await pollAccessToken(device)
  await mkdir(dirname(TOKEN_PATH), { recursive: true })
  await writeFile(TOKEN_PATH, token, { mode: 0o600 })
  console.log(`Authentication saved to ${TOKEN_PATH}`)
}

async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  })
  if (!response.ok) throw await httpError("Device authentication failed", response)
  return await response.json() as DeviceCode
}

async function pollAccessToken(device: DeviceCode): Promise<string> {
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
    if (reply.access_token) return reply.access_token
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
