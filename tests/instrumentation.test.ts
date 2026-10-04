import { expect, mock, spyOn, test } from "bun:test"
import { Instrumentation } from "../src/instrumentation.ts"
import { createServer } from "../src/server.ts"
import type { Provider } from "../src/server.ts"
import type { LogEntry } from "../src/log.ts"

function fixture() {
  const logs: LogEntry[] = []
  const logger = { write: async (entry: LogEntry) => { logs.push(structuredClone(entry)) } }
  const metrics = new Instrumentation(logger)
  return { logs, logger, metrics }
}

function provider(response: () => Promise<Response>): Provider {
  return {
    health: async () => ({ status: "ready" }),
    models: async () => ({ data: [] }),
    codexModels: async () => ({ models: [] }),
    response, codexResponse: response, chatCompletion: response,
  }
}

function request(path = "/codex/v1/responses", signal?: AbortSignal) {
  return new Request(`http://localhost${path}`, { method: "POST", body: '{"model":"m","input":"private-prompt"}', signal })
}

function sse(body: string) {
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

test("all inference routes have one correlation ID and exactly one complete lifecycle", async () => {
  const { logs, logger, metrics } = fixture()
  const handler = createServer({
    ...provider(async () => Response.json({ object: "response", status: "completed" })),
    chatCompletion: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
  }, logger, metrics)
  for (const path of ["/codex/v1/responses", "/responses/v1/responses", "/v1/responses", "/chat/v1/chat/completions", "/v1/chat/completions"]) {
    const response = await handler(request(path))
    const id = response.headers.get("x-provider-request-id")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get("x-provider-error-source")).toBe("none")
    expect(metrics.snapshot().inFlight).toBe(1)
    await response.text()
    const entries = logs.filter(log => log.requestId === id)
    expect(entries.filter(log => log.event === "request_started")).toHaveLength(1)
    expect(entries.filter(log => log.event === "response_headers")).toHaveLength(1)
    expect(entries.filter(log => log.event === "request_completed")).toHaveLength(1)
    expect(entries.at(-1)).toMatchObject({ event: "request_completed", outcome: "success", route: path, responseBytes: expect.any(Number) })
  }
  expect(metrics.snapshot()).toMatchObject({ inFlight: 0, totals: { started: 5, completed: 5, success: 5 } })
  expect(JSON.stringify(logs)).not.toContain("private-prompt")
})

test("latency includes the full body and separates headers from first byte", async () => {
  let now = 100
  const logs: LogEntry[] = []
  const metrics = new Instrumentation({ write: async entry => { logs.push(entry) } }, () => now)
  const context = await metrics.begin(request(), "/codex/v1/responses")
  let send!: (text: string) => void
  let close!: () => void
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      send = text => controller.enqueue(new TextEncoder().encode(text))
      close = () => controller.close()
    },
  }))
  now = 110
  const response = await context.response(upstream)
  const reader = response.body!.getReader()
  now = 120
  send("first")
  await reader.read()
  expect(metrics.snapshot().inFlight).toBe(1)
  now = 140
  close()
  expect((await reader.read()).done).toBe(true)
  expect(logs.at(-1)).toMatchObject({
    event: "request_completed", durationMs: 40, headersMs: 10, firstByteMs: 20, responseBytes: 5,
  })
  expect(metrics.snapshot().window).toMatchObject({
    latencyMs: { p50: 40, p95: 40 }, headersMs: { p50: 10 }, firstByteMs: { p50: 20 },
  })
})

test.each([
  { body: 'data: {"type":"response.completed","response":{"output":[]}}\n\n', outcome: "success", category: undefined },
  { body: 'data: {"type":"response.failed","response":{"error":{"message":"private"}}}\n\n', outcome: "failure", category: "stream_failed" },
  { body: 'event: response.incomplete\ndata: {"response":{}}\n\n', outcome: "incomplete", category: "stream_incomplete" },
  { body: 'data: {"type":"response.output_text.delta","delta":"private"}\n\n', outcome: "failure", category: "stream_truncated" },
  { body: 'data: {invalid\n\n', outcome: "failure", category: "stream_parse_error" },
])("HTTP 200 is classified by SSE terminal state: $outcome $category", async ({ body, outcome, category }) => {
  const { logs, metrics } = fixture()
  const context = await metrics.begin(request(), "/codex/v1/responses")
  const response = await context.response(sse(body), "responses")
  expect(await response.text()).toBe(body)
  expect(logs.at(-1)).toMatchObject({ event: "request_completed", status: 200, outcome, category })
  expect(metrics.snapshot().inFlight).toBe(0)
  expect(metrics.snapshot().service.status).toBe(outcome === "failure" ? "degraded" : "healthy")
  expect(JSON.stringify(logs)).not.toContain("private")
})

test("native Chat streams require both a finish reason and DONE", async () => {
  for (const done of [true, false]) {
    const { logs, metrics } = fixture()
    const context = await metrics.begin(request("/chat/v1/chat/completions"), "/chat/v1/chat/completions")
    const body = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + (done ? "data: [DONE]\n\n" : "")
    expect(await (await context.response(sse(body), "chat-completions")).text()).toBe(body)
    expect(logs.at(-1)?.outcome).toBe(done ? "success" : "failure")
  }
})

test("non-stream JSON failures and incomplete responses are not reported as successful inference", async () => {
  for (const [status, outcome] of [["failed", "failure"], ["incomplete", "incomplete"], ["completed", "success"]] as const) {
    const { logs, metrics } = fixture()
    const context = await metrics.begin(request(), "/codex/v1/responses")
    const response = await context.response(Response.json({ object: "response", status, output: [] }), "responses")
    await response.text()
    expect(logs.at(-1)?.outcome).toBe(outcome)
  }
})

test("HTTP rejection and client cancellation do not degrade service quality", async () => {
  const { logs, metrics } = fixture()
  const good = await metrics.begin(request(), "/codex/v1/responses")
  await (await good.response(new Response("ok"))).text()
  const rejected = await metrics.begin(request(), "/codex/v1/responses")
  rejected.setSource("upstream")
  const response = await rejected.response(new Response("failed to parse request", { status: 413 }))
  expect(response.status).toBe(413)
  expect(response.headers.get("x-provider-error-source")).toBe("upstream")
  await response.text()
  const controller = new AbortController()
  const cancelled = await metrics.begin(request("/codex/v1/responses", controller.signal), "/codex/v1/responses")
  controller.abort()
  await (await cancelled.response(new Response("ignored"))).text()
  expect(metrics.snapshot()).toMatchObject({
    inFlight: 0, service: { status: "healthy" },
    totals: { success: 1, rejected: 1, cancelled: 1, completed: 3 },
    window: { failureRate: 0 },
  })
  expect(logs.filter(log => log.event === "request_completed" && log.requestId === cancelled.id)).toHaveLength(1)
})

test("disconnect after partial output cancels upstream and emits a single terminal record", async () => {
  const { logs, metrics } = fixture()
  let cancelled = false
  const context = await metrics.begin(request(), "/codex/v1/responses")
  const response = await context.response(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("partial")) },
    cancel() { cancelled = true },
  })))
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  expect(cancelled).toBe(true)
  expect(logs.filter(log => log.event === "request_completed")).toHaveLength(1)
  expect(logs.at(-1)).toMatchObject({ outcome: "cancelled", category: "client_cancelled", responseBytes: 7 })
  expect(metrics.snapshot().inFlight).toBe(0)
})

test("signal abort terminates a pending body read without leaking an active request", async () => {
  const { logs, metrics } = fixture()
  const controller = new AbortController()
  let cancelled = false
  const context = await metrics.begin(request("/codex/v1/responses", controller.signal), "/codex/v1/responses")
  const response = await context.response(new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true },
  })))
  const read = response.text()
  controller.abort()
  await expect(read).rejects.toHaveProperty("name", "AbortError")
  await Bun.sleep(0)
  expect(cancelled).toBe(true)
  expect(metrics.snapshot().inFlight).toBe(0)
  expect(logs.filter(log => log.event === "request_completed")).toHaveLength(1)
})

test("body transport errors record failure without logging the error body or message", async () => {
  const { logs, metrics } = fixture()
  const context = await metrics.begin(request(), "/codex/v1/responses")
  const response = await context.response(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("private-upstream-error")) },
  })))
  await expect(response.text()).rejects.toThrow("private-upstream-error")
  expect(logs.at(-1)).toMatchObject({ outcome: "failure", category: "response_body_error" })
  expect(JSON.stringify(logs)).not.toContain("private-upstream-error")
  expect(metrics.snapshot()).toMatchObject({ inFlight: 0, totals: { failure: 1 } })
})

test("bounded inspection never turns unverifiable large output into a false success", async () => {
  for (const response of [
    sse(`data: ${"x".repeat(1_000_001)}\n\n`),
    Response.json({ status: "completed", output: "x".repeat(1_000_001) }),
  ]) {
    const { logs, metrics } = fixture()
    const context = await metrics.begin(request(), "/codex/v1/responses")
    await (await context.response(response, "responses")).text()
    expect(logs.at(-1)?.outcome).toBe("unverified")
    expect(metrics.snapshot().totals).toMatchObject({ success: 0, unverified: 1 })
  }
})

test("readiness uses HTTP 503, liveness is independent, and probes do not affect request metrics", async () => {
  const { logger, metrics } = fixture()
  const health = mock(async () => ({ status: "reauth-required", code: "github-credential-rejected" }))
  const handler = createServer({ ...provider(async () => new Response()), health }, logger, metrics)
  const ready = await handler(new Request("http://localhost/health/ready"))
  expect(ready.status).toBe(503)
  expect(await ready.json()).toMatchObject({ status: "reauth-required" })
  const legacy = await handler(new Request("http://localhost/health"))
  expect(legacy.status).toBe(200)
  const live = await handler(new Request("http://localhost/health/live"))
  expect(live.status).toBe(200)
  expect(await live.json()).toMatchObject({ status: "live" })
  const aggregate = await handler(new Request("http://localhost/health/metrics"))
  expect(await aggregate.json()).toMatchObject({
    status: "unavailable", totals: { started: 0, completed: 0 }, dependency: { status: "reauth-required" },
  })
  expect(health).toHaveBeenCalledTimes(2)
})

test("service and dependency health transitions are emitted only when the state changes", async () => {
  const { logs, metrics } = fixture()
  metrics.observeDependency({ status: "ready" })
  metrics.observeDependency({ status: "ready", observedAt: "2026-10-04T05:00:00Z" })
  metrics.observeDependency({ status: "upstream-unavailable", code: "upstream-unavailable" }, "request-1")
  for (const status of [200, 200, 503, 503, 200]) {
    const context = await metrics.begin(request(), "/codex/v1/responses")
    await (await context.response(new Response("body", { status }))).text()
  }
  expect(logs.filter(log => log.event === "health" && log.scope === "dependency").map(log => log.healthStatus))
    .toEqual(["ready", "upstream-unavailable"])
  expect(logs.filter(log => log.event === "health" && log.scope === "service").map(log => log.healthStatus))
    .toEqual(["healthy", "degraded", "healthy"])
  expect(metrics.snapshot()).toMatchObject({ status: "unavailable", window: { failureRate: 0.4 } })
})

test("rolling metrics are time- and size-bounded while lifetime counters remain accurate", async () => {
  let now = 1_000
  const metrics = new Instrumentation(undefined, () => now)
  for (let index = 0; index < 1_002; index++) {
    const context = await metrics.begin(request(), "/codex/v1/responses")
    await context.response(new Response(null, { status: 204 }))
  }
  expect(metrics.snapshot()).toMatchObject({ totals: { started: 1_002, completed: 1_002 }, window: { samples: 1_000 } })
  now += 5 * 60_000
  expect(metrics.snapshot()).toMatchObject({
    totals: { completed: 1_002 }, window: { samples: 0, failureRate: null, latencyMs: { p50: null } },
    service: { stale: true },
  })
})

test("logging failures are explicit and do not prevent HTTP delivery or leak request state", async () => {
  const warning = spyOn(console, "error").mockImplementation(() => {})
  try {
    const metrics = new Instrumentation({ write: async () => { throw new Error("private path") } })
    const context = await metrics.begin(request(), "/codex/v1/responses")
    expect(await (await context.response(new Response("ok"))).text()).toBe("ok")
    expect(metrics.snapshot()).toMatchObject({
      inFlight: 0, service: { status: "degraded", code: "instrumentation_log_failure" },
      totals: { success: 1 },
    })
    expect(metrics.snapshot().logging.failures).toBeGreaterThan(0)
    expect(warning).toHaveBeenCalled()
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private path")
  } finally {
    warning.mockRestore()
  }
})

test("unknown paths are redacted rather than logging query or path secrets", async () => {
  const { logs, logger, metrics } = fixture()
  const handler = createServer(provider(async () => new Response()), logger, metrics)
  await (await handler(new Request("http://localhost/private-token-path?api_key=private-token"))).text()
  expect(logs.filter(log => log.event === "request_completed")[0]).toMatchObject({ route: "/unknown", outcome: "rejected" })
  expect(JSON.stringify(logs)).not.toContain("private-token")
})

test("ongoing successful traffic refreshes health freshness without repeating transition logs", async () => {
  let now = 1_000
  const logs: LogEntry[] = []
  const metrics = new Instrumentation({ write: async entry => { logs.push(entry) } }, () => now)
  for (let index = 0; index < 3; index++) {
    const context = await metrics.begin(request(), "/codex/v1/responses")
    await context.response(new Response(null, { status: 204 }))
    expect(metrics.snapshot().service.stale).toBe(false)
    now += 4 * 60_000
  }
  expect(logs.filter(log => log.scope === "service")).toHaveLength(1)
})

test("deadline expiry is a service failure rather than a user cancellation", async () => {
  const { logs, metrics } = fixture()
  const controller = new AbortController()
  const context = await metrics.begin(request("/codex/v1/responses", controller.signal), "/codex/v1/responses")
  controller.abort(new DOMException("Deadline exceeded.", "TimeoutError"))
  await context.response(new Response(null, { status: 204 }))
  const terminal = logs.find(log => log.event === "request_completed")
  expect(terminal).toMatchObject({ outcome: "failure", category: "request_timeout" })
  expect(metrics.snapshot()).toMatchObject({ inFlight: 0, totals: { failure: 1, cancelled: 0 } })
})

test("HTTP success without a recognized inference terminal marker is explicitly unverified", async () => {
  for (const upstream of [Response.json({}), Response.json(null), new Response("unknown protocol"), new Response(null)]) {
    const { logs, metrics } = fixture()
    const context = await metrics.begin(request(), "/codex/v1/responses")
    await (await context.response(upstream, "responses")).text()
    expect(logs.filter(log => log.event === "request_completed")[0]?.outcome).toBe("unverified")
    expect(metrics.snapshot().totals.success).toBe(0)
  }
})
