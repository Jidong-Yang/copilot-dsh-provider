import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { authenticate, readGitHubToken } from "./auth.ts"
import { codexConfig } from "./codex-config.ts"
import { CODEX_CATALOG_PATH } from "./config.ts"
import { CopilotClient } from "./copilot.ts"
import { createServer } from "./server.ts"

const [command = "start", argument] = process.argv.slice(2)

if (command === "auth") {
  await authenticate()
} else if (command === "codex-config") {
  const port = providerPort()
  const model = argument?.trim() || "gpt-5.6-sol"
  const client = new CopilotClient(readGitHubToken)
  const catalog = await client.codexModels()
  if (!hasCodexModel(catalog, model)) {
    throw new Error(`Model "${model}" is not in the current Copilot Responses catalog`)
  }
  await mkdir(dirname(CODEX_CATALOG_PATH), { recursive: true })
  await writeFile(CODEX_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(codexConfig(
    model,
    port,
    CODEX_CATALOG_PATH,
  ))
} else if (command === "start") {
  const port = providerPort()
  const client = new CopilotClient(readGitHubToken)
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createServer(client),
    idleTimeout: 255,
  })
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

function hasCodexModel(catalog: object, model: string): boolean {
  if (!("models" in catalog) || !Array.isArray(catalog.models)) return false
  return catalog.models.some(item =>
    typeof item === "object"
    && item !== null
    && "slug" in item
    && item.slug === model)
}
