import { authenticate, readGitHubToken } from "./auth.ts"
import { CopilotClient } from "./copilot.ts"
import { createServer } from "./server.ts"

const [command = "start"] = process.argv.slice(2)

if (command === "auth") {
  await authenticate()
} else if (command === "start") {
  const port = Number(process.env["PORT"] ?? "4141")
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535")
  }
  const client = new CopilotClient(await readGitHubToken())
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createServer(client),
    idleTimeout: 255,
  })
  console.log(`Copilot DSH Provider listening at http://127.0.0.1:${port}`)
} else {
  throw new Error(`Unknown command: ${command}`)
}
