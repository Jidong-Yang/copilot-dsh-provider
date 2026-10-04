import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLogger, errorLog, safeToolTypes } from "../src/log.ts"

let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test("appends structured runtime entries to the configured local log", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-provider-log-"))
  const path = join(directory, "logs", "provider.log")
  const logger = await createLogger(path, 4141)
  await logger.write({ event: "start", port: 4141 })
  await logger.write({ event: "request", route: "/codex/v1/responses", status: 200, durationMs: 12 })

  const entries = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ event: "start", port: 4141 })
  expect(entries[1]).toMatchObject({
    event: "request", port: 4141, route: "/codex/v1/responses", status: 200, durationMs: 12,
  })
  expect(entries[0].timestamp).toBeString()
})

test("logs only safe adapter paths and constrained tool categories", () => {
  expect(errorLog(new TypeError("Unsupported request.tools[8].tools"))).toEqual({
    category: "invalid-adapter-request", field: "request.tools[8].tools",
  })

  expect(errorLog(new Error("Authorization: secret"))).toEqual({
    category: "provider-failure",
  })
  expect(safeToolTypes({ tools: [{ type: "namespace" }, { type: "token=private" }] }))
    .toEqual(["namespace", "other"])
})

test("serializes concurrent entries and recovers the queue after an explicitly rejected write", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-provider-log-"))
  const path = join(directory, "provider.log")
  const logger = await createLogger(path)
  await Promise.all(Array.from({ length: 20 }, (_, index) => logger.write({
    event: "request_completed", requestId: String(index),
  })))
  const entries = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(entries.map(entry => entry.requestId)).toEqual(Array.from({ length: 20 }, (_, index) => String(index)))
  await rm(path)
  await mkdir(path)
  await expect(logger.write({ event: "start" })).rejects.toBeInstanceOf(Error)
  await rm(path, { recursive: true })
  await logger.write({ event: "start" })
  expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ event: "start" })
})
