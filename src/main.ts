import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { authenticate, readGitHubToken } from "./auth.ts"
import { codexConfig } from "./codex-config.ts"
import { CODEX_CATALOG_PATH } from "./config.ts"
import { CopilotClient } from "./copilot.ts"
import { createServer } from "./server.ts"
import { MAX_REQUEST_BODY_BYTES } from "./codex-request.ts"
import { createLogger } from "./log.ts"

const [command = "start", argument] = process.argv.slice(2)

if (command === "auth") {
  await authenticate()
} else if (command === "auth-status") {
  const client = new CopilotClient(readGitHubToken)
  const health = await client.health()
  console.log(JSON.stringify(health))
  if (health.status !== "ready") process.exitCode = health.status === "reauth-required" ? 2 : 3
} else if (command === "codex-config") {
  const port = providerPort()
  const model = argument?.trim() || "gpt-6.1-sol"
  const client = new CopilotClient(readGitHubToken)
  const catalog = await client.codexModels()
  const reasoningEffort = codexReasoningEffort(catalog, model)
  if (reasoningEffort === undefined) {
    throw new Error(`Model "${model}" is not in the current Copilot Codex catalog`)
  }
  await mkdir(dirname(CODEX_CATALOG_PATH), { recursive: true })
  await writeFile(CODEX_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(codexConfig(
    model,
    port,
    CODEX_CATALOG_PATH,
    reasoningEffort,
  ))
} else if (command === "start") {
  const port = providerPort()
  const logger = await createLogger(undefined, port)
  const client = new CopilotClient(readGitHubToken, logger)
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createServer(client, logger),
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  })
  await logger.write({ event: "start", port })
  console.log(`Copilot model provider listening at http://127.0.0.1:${port}`)
} else {
  throw new Error(`Unknown command: ${command}`)
}

function providerPort(): number {
  const port = Number(process.env["PORT"] ?? "4141")
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535")
  }
  return port
}

function codexReasoningEffort(catalog: object, model: string): string | null | undefined {
  if (!("models" in catalog) || !Array.isArray(catalog.models)) return undefined
  for (const item of catalog.models) {
    if (typeof item !== "object" || item === null || !("slug" in item) || item.slug !== model) continue
    if (!("default_reasoning_level" in item)) return undefined
    const effort: unknown = item.default_reasoning_level
    if (effort === null || typeof effort === "string") return effort
  }
  return undefined
}
