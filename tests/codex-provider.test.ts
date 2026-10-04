import { afterEach, expect, mock, test } from "bun:test"
import { CopilotClient } from "../src/copilot.ts"
import { createServer } from "../src/server.ts"
import { CodexRequestError, MAX_REQUEST_BODY_BYTES, readCodexRequest } from "../src/codex-request.ts"
import type { LogEntry } from "../src/log.ts"
import { Instrumentation } from "../src/instrumentation.ts"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const models = [
  { id: "native", supported_endpoints: ["responses"], capabilities: {
    limits: { max_context_window_tokens: 100_000, max_prompt_tokens: 60_000, max_output_tokens: 20_000 },
  } },
  { id: "chat", supported_endpoints: ["chat/completions"] },
  { id: "both", supported_endpoints: ["responses", "chat/completions"] },
  { id: "hidden", supported_endpoints: ["responses"], model_picker_enabled: false },
  { id: "unsupported", supported_endpoints: ["embeddings"] },
]

function installUpstream(inference: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; payload: unknown; signal: AbortSignal | null | undefined }> = []
  let catalogs = 0
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/copilot_internal/v2/token")) return Response.json({
      token: "test-session", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1500,
    })
    if (url.endsWith("/models")) {
      catalogs++
      return Response.json({ data: models })
    }
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    requests.push({ url, payload: JSON.parse(init.body), signal: init.signal })
    return inference(url, init)
  })
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  return { requests, catalogs: () => catalogs }
}

test("Codex selects the advertised protocol, prefers native Responses and caches routing metadata", async () => {
  const fixture = installUpstream(() => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "hello" } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }))
  const logs: LogEntry[] = []
  const client = new CopilotClient("test-github", { write: async entry => { logs.push(entry) } })
  const controller = new AbortController()
  const nativePayload = { model: "native", input: "hi", reasoning: null, store: false }
  await client.codexResponse(nativePayload, controller.signal)
  await client.codexResponse({ ...nativePayload, model: "both" })
  const converted = await client.codexResponse({ model: "chat", input: "hi", reasoning: null, store: false })
  expect(fixture.requests.map(request => request.url)).toEqual([
    "https://api.githubcopilot.com/responses",
    "https://api.githubcopilot.com/responses",
    "https://api.githubcopilot.com/chat/completions",
  ])
  expect(fixture.requests[0]!.payload).toEqual(nativePayload)
  expect(fixture.requests[0]!.signal).toBe(controller.signal)
  expect(fixture.requests[2]!.payload).toEqual({ model: "chat", messages: [{ role: "user", content: "hi" }] })
  expect(await converted.json()).toMatchObject({
    object: "response", status: "completed", model: "chat",
    output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
    usage: { input_tokens: 4, output_tokens: 2 },
  })
  expect(fixture.catalogs()).toBe(1)
  expect(logs[2]).toMatchObject({ event: "upstream", protocol: "chat-completions", source: "upstream", status: 200 })
  expect(logs[0]!.requestBytes).toBe(Buffer.byteLength(JSON.stringify(nativePayload)))
  expect(JSON.stringify(logs)).not.toContain("test-github")
  expect(JSON.stringify(logs)).not.toContain('"input"')
})

test("Codex catalogs include convertible models, current instruction schema and compaction headroom", async () => {
  installUpstream(() => new Response())
  const catalog = await new CopilotClient("test-github").codexModels() as {
    models: Array<Record<string, unknown>>
  }
  expect(catalog.models.map(model => model["slug"])).toEqual(["native", "chat", "both"])
  expect(catalog.models[0]).toMatchObject({
    auto_compact_token_limit: 60_000,
    supports_search_tool: false,
    effective_context_window_percent: 95,
    model_messages: { instructions_template: expect.any(String) },
  })
})

test("Codex does not issue inference for invalid, stateful or unrepresentable requests", async () => {
  const fixture = installUpstream(() => new Response())
  const client = new CopilotClient("test-github")
  for (const payload of [
    {}, { model: "" }, { model: "hidden", input: "hi" }, { model: "missing", input: "hi" },
    { model: "unsupported", input: "hi" },
    { model: "native", input: "hi", store: true },
    { model: "native", input: [], previous_response_id: "resp_secret" },
    { model: "chat", input: [], tools: [{ type: "web_search" }] },
    { model: "chat", input: [{ type: "reasoning", encrypted_content: "private" }] },
  ]) {
    await expect(client.codexResponse(payload)).rejects.toBeInstanceOf(CodexRequestError)
  }
  expect(fixture.requests).toHaveLength(0)
})

test("Codex makes namespace function strictness explicit without changing history or user payload", async () => {
  const fixture = installUpstream(() => new Response("ok"))
  const payload = { model: "native", input: [{ role: "user", content: "hi" }], tools: [{
    type: "namespace", name: "functions", description: "Tools", tools: [
      { type: "function", name: "shell" }, { type: "function", name: "patch", strict: true },
    ],
  }] }
  const before = structuredClone(payload)
  await new CopilotClient("test-github").codexResponse(payload)
  expect(payload).toEqual(before)
  expect(fixture.requests[0]!.payload).toMatchObject({
    tools: [{ tools: [{ strict: false }, { strict: true }] }],
  })
})

test("Codex preserves upstream 413 and its request ID while marking the error source", async () => {
  const body = '{"error":{"message":"failed to parse request","code":""}}'
  const fixture = installUpstream(() => new Response(body, {
    status: 413, headers: { "content-type": "application/json", "x-request-id": "test-413" },
  }))
  const logs: LogEntry[] = []
  const logger = { write: async (entry: LogEntry) => { logs.push(entry) } }
  const handler = createServer(new CopilotClient("test-github", logger), logger)
  for (const model of ["native", "chat"]) {
    const response = await handler(new Request("http://localhost/codex/v1/responses", {
      method: "POST", body: JSON.stringify({ model, input: "hi" }),
    }))
    expect(response.status).toBe(413)
    expect(response.headers.get("x-provider-error-source")).toBe("upstream")
    expect(response.headers.get("x-request-id")).toBe("test-413")
    expect(await response.text()).toBe(body)
  }
  expect(fixture.requests).toHaveLength(2)
  const inferenceLogs = logs.filter(log => log.event === "upstream" && log.stage === "inference")
  expect(inferenceLogs).toHaveLength(2)
  expect(inferenceLogs[0]).toMatchObject({ status: 413, upstreamRequestId: "test-413", requestBytes: expect.any(Number) })
})

test("Codex local JSON, compression and compaction errors are explicit and never reach inference", async () => {
  const fixture = installUpstream(() => new Response())
  const handler = createServer(new CopilotClient("test-github"))
  for (const [path, body, headers, status, code] of [
    ["/codex/v1/responses", "{private", {}, 400, "invalid_json"],
    ["/codex/v1/responses", "{}", { "content-encoding": "snappy" }, 415, "unsupported_content_encoding"],
    ["/codex/v1/responses", "{}", { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }, 413, "request_body_too_large"],
    ["/codex/v1/responses/compact", "{}", {}, 501, "remote_compaction_unsupported"],
  ] as const) {
    const response = await handler(new Request(`http://localhost${path}`, { method: "POST", body, headers }))
    expect(response.status).toBe(status)
    expect(response.headers.get("x-provider-error-source")).toBe("provider")
    expect(await response.json()).toMatchObject({ error: { code } })
  }
  expect(fixture.requests).toHaveLength(0)
})

test("request limits count UTF-8 bytes and reject oversized chunked and decompressed bodies", async () => {
  const body = JSON.stringify({ input: "世界" })
  const limit = Buffer.byteLength(body)
  expect(limit).toBeGreaterThan(body.length)
  expect((await readCodexRequest(new Request("http://localhost", { method: "POST", body }), limit)).requestBytes).toBe(limit)
  await expect(readCodexRequest(new Request("http://localhost", { method: "POST", body }), limit - 1))
    .rejects.toMatchObject({ status: 413, code: "request_body_too_large" })
  for (const encoding of ["gzip", "deflate", "zstd"] as const) {
    const compressed = await new Response(
      new Blob([body]).stream().pipeThrough(new CompressionStream(encoding)),
    ).arrayBuffer()
    const request = () => new Request("http://localhost", {
      method: "POST", body: compressed, headers: { "content-encoding": encoding },
    })
    expect((await readCodexRequest(request())).payload).toEqual({ input: "世界" })
    await expect(readCodexRequest(request(), limit - 1)).rejects.toMatchObject({ status: 413 })
  }
  await expect(readCodexRequest(new Request("http://localhost", {
    method: "POST", body: "not gzip", headers: { "content-encoding": "gzip" },
  }))).rejects.toMatchObject({ status: 400 })
})

test("Codex local summarization uses the same inference adapter over a real HTTP connection", async () => {
  const fixture = installUpstream(() => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "Checkpoint: preserve user goal and remaining work." } }],
    usage: { prompt_tokens: 10, completion_tokens: 6 },
  }))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createServer(new CopilotClient("test-github")) })
  try {
    const response = await originalFetch(new URL("/codex/v1/responses", server.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat", instructions: "Summarize prior work for continuation.",
        input: [{ role: "user", content: "Summarize this conversation." }],
        tools: [], tool_choice: "none", reasoning: null, store: false, include: [],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "completed", output: [{ content: [{ text: "Checkpoint: preserve user goal and remaining work." }] }],
    })
    expect(fixture.requests[0]!.payload).toMatchObject({
      model: "chat", tool_choice: "none",
      messages: [{ role: "developer", content: "Summarize prior work for continuation." },
        { role: "user", content: "Summarize this conversation." }],
    })
  } finally {
    await server.stop(true)
  }
})

test("authorization recovery has correlated upstream attempts but only one successful request", async () => {
  let attempts = 0
  installUpstream(() => ++attempts === 1 ? new Response("denied", { status: 401 }) : Response.json({
    object: "response", status: "completed", output: [],
  }, { headers: { "x-request-id": "upstream-final" } }))
  const logs: LogEntry[] = []
  const logger = { write: async (entry: LogEntry) => { logs.push(entry) } }
  const metrics = new Instrumentation(logger)
  const handler = createServer(new CopilotClient("test-github", logger), logger, metrics)
  const response = await handler(new Request("http://localhost/codex/v1/responses", {
    method: "POST", body: '{"model":"native","input":"hi"}',
  }))
  const id = response.headers.get("x-provider-request-id")
  await response.text()
  const upstream = logs.filter(log => log.event === "upstream" && log.stage === "inference")
  expect(upstream.map(log => [log.attempt, log.status])).toEqual([[1, 401], [2, 200]])
  expect(upstream.every(log => log.requestId === id)).toBe(true)
  expect(upstream[0]?.upstreamClientRequestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(upstream[1]?.upstreamRequestId).toBe("upstream-final")
  expect(logs.filter(log => log.event === "request_completed")).toHaveLength(1)
  expect(logs.at(-1)).toMatchObject({ requestId: id, outcome: "success", upstreamAttempts: 3 })
  expect(metrics.snapshot()).toMatchObject({ inFlight: 0, totals: { started: 1, completed: 1, success: 1 } })
})

test("aborted inference does not poison shared authentication or upstream availability health", async () => {
  let begin!: () => void
  const began = new Promise<void>(resolve => { begin = resolve })
  installUpstream((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    begin()
  }))
  const client = new CopilotClient("test-github")
  const metrics = new Instrumentation()
  const handler = createServer(client, undefined, metrics)
  const controller = new AbortController()
  const pending = handler(new Request("http://localhost/codex/v1/responses", {
    method: "POST", body: '{"model":"native","input":"hi"}', signal: controller.signal,
  }))
  await began
  controller.abort()
  await pending
  expect((await client.health()).status).toBe("ready")
  expect(metrics.snapshot()).toMatchObject({
    inFlight: 0, dependency: { status: "ready" }, totals: { cancelled: 1, failure: 0, completed: 1 },
  })
})
