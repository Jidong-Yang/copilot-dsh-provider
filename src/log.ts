import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { PROVIDER_HOME } from "./config.ts"
import { failureCodeFrom } from "./errors.ts"
import type { StreamSummary } from "./stream-diagnostics.ts"
import type { RequestOutcome } from "./instrumentation.ts"

export const LOG_PATH = join(PROVIDER_HOME, "provider.log")

export interface LogEntry {
  event: "start" | "request" | "failure" | "stream" | "upstream"
    | "request_started" | "response_headers" | "request_completed" | "health"
  route?: string
  method?: string
  status?: number
  durationMs?: number
  port?: number
  processId?: number
  category?: string
  field?: string
  toolTypes?: string[]
  requestId?: string
  upstreamRequestId?: string
  upstreamClientRequestId?: string
  stage?: "inference" | "models"
  attempt?: number
  upstreamAttempts?: number
  headersMs?: number
  firstByteMs?: number
  responseBytes?: number
  outcome?: RequestOutcome
  scope?: "dependency" | "service"
  healthStatus?: string
  previousHealthStatus?: string
  requestBytes?: number
  protocol?: "responses" | "chat-completions"
  source?: "provider" | "upstream"
  stream?: StreamSummary
}

export interface RequestLogger {
  write: (entry: LogEntry) => Promise<void>
}

export async function createLogger(path = LOG_PATH, port?: number): Promise<RequestLogger> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, "", { mode: 0o600 })
  let pending: Promise<void> = Promise.resolve()
  return {
    write: entry => {
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
        ...(port === undefined ? {} : { port }),
        processId: process.pid,
      })}\n`
      const write = pending.then(() => appendFile(path, line, { mode: 0o600 }))
      // Preserve queue progress after a failure while returning the rejected write to its caller.
      pending = write.catch(() => {})
      return write
    },
  }
}

export function errorLog(error: unknown): Pick<LogEntry, "category" | "field"> {
  const code = failureCodeFrom(error)
  if (code) return { category: code }
  if (error instanceof TypeError) {
    const field = /^(?:Unsupported )?(request(?:\.[a-z_]+|\[\d+\])+)(?:\b|$)/.exec(error.message)?.[1]
    return { category: "invalid-adapter-request", ...(field ? { field } : {}) }
  }
  return { category: "provider-failure" }
}

export function safeToolTypes(payload: unknown): string[] | undefined {
  if (typeof payload !== "object" || payload === null || !("tools" in payload)
    || !Array.isArray(payload.tools)) return undefined
  return payload.tools.map(tool => {
    const type = typeof tool === "object" && tool !== null && "type" in tool
      ? tool.type : undefined
    return typeof type === "string" && /^[a-z_]{1,30}$/.test(type)
      ? type : "other"
  })
}
