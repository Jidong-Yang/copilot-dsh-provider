import { expect, mock, test } from "bun:test"

import { createServer } from "../src/server.ts"
import type { Provider } from "../src/server.ts"
import { ProviderRequestError } from "../src/errors.ts"

test("serves health without exposing credentials or CORS", async () => {
  const handler = createServer({
    health: (signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve({
      status: "reauth-required",
      code: "github-credential-rejected",
      observedAt: "2026-08-27T04:00:00.000Z",
      })
    },
    models: () => Promise.resolve({ object: "list", data: [] }),
    codexModels: () => Promise.resolve({ models: [] }),
    response: () => Promise.resolve(new Response()),
    chatCompletion: () => Promise.resolve(new Response()),
  })
  const health = await handler(new Request("http://localhost/health", {
    headers: { origin: "https://example.com" },
  }))
  const token = await handler(new Request("http://localhost/token"))

  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({
    status: "reauth-required",
    code: "github-credential-rejected",
    observedAt: "2026-08-27T04:00:00.000Z",
  })
  expect(health.headers.get("access-control-allow-origin")).toBeNull()
  expect(token.status).toBe(404)
  expect(await token.text()).not.toContain("secret")
})

test("passes a Responses request and response through unchanged", async () => {
  const client: Provider = {
    health: () => Promise.resolve({
      status: "ready",
      observedAt: "2026-08-27T04:00:00.000Z",
    }),
    response: mock((payload: unknown, signal?: AbortSignal) => {
      expect(payload).toEqual({
        model: "gpt-5.6-sol",
        input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
        reasoning: { effort: "max" },
        stream: true,
      })
      expect(signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(new Response("data: response.completed\n\n", {
        headers: { "content-type": "text/event-stream" },
      }))
    }),
    models: mock(() => Promise.resolve({ object: "list", data: [] })),
    codexModels: () => Promise.resolve({ models: [] }),
    chatCompletion: () => Promise.resolve(new Response()),
  }
  const handler = createServer(client)

  const response = await handler(new Request("http://localhost/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
      reasoning: { effort: "max" },
      stream: true,
    }),
  }))

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(await response.text()).toBe("data: response.completed\n\n")
})

test("routes protocol-specific model catalogs and Chat Completions", async () => {
  const models = mock((protocol: "chat-completions" | "responses") =>
    Promise.resolve({ object: "list", data: [{ id: protocol }] }))
  const chatCompletion = mock((payload: unknown, signal?: AbortSignal) => {
    expect(payload).toEqual({
      model: "gemini-3.7-flash",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    return Promise.resolve(Response.json({ choices: [] }))
  })
  const handler = createServer({
    health: () => Promise.resolve({ status: "ready" }),
    models,
    codexModels: () => Promise.resolve({ models: [] }),
    response: () => Promise.resolve(new Response()),
    chatCompletion,
  })

  const responsesModels = await handler(new Request("http://localhost/responses/v1/models"))
  const chatModels = await handler(new Request("http://localhost/chat/v1/models"))
  const completion = await handler(new Request("http://localhost/chat/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gemini-3.7-flash",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
    }),
  }))

  expect(await responsesModels.json()).toEqual({
    object: "list",
    data: [{ id: "responses" }],
  })
  expect(await chatModels.json()).toEqual({
    object: "list",
    data: [{ id: "chat-completions" }],
  })
  expect(await completion.json()).toEqual({ choices: [] })
  expect(models).toHaveBeenCalledTimes(2)
  expect(chatCompletion).toHaveBeenCalledTimes(1)
})

test("serves Codex Responses aliases", async () => {
  const codexModels = mock(() => Promise.resolve({
    models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }],
  }))
  const response = mock((payload: unknown) => {
    expect(payload).toEqual({ model: "gpt-5.6-sol", input: "hello", stream: true })
    return Promise.resolve(new Response("data: response.completed\n\n", {
      headers: { "content-type": "text/event-stream" },
    }))
  })
  const handler = createServer({
    health: () => Promise.resolve({ status: "ready" }),
    models: () => Promise.resolve({ object: "list", data: [] }),
    codexModels,
    response,
    chatCompletion: () => Promise.resolve(new Response()),
  })

  const catalog = await handler(new Request("http://localhost/codex/v1/models"))
  const completion = await handler(new Request("http://localhost/codex/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
  }))

  expect(catalog.status).toBe(200)
  expect(await catalog.json()).toEqual({
    models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }],
  })
  expect(completion.status).toBe(200)
  expect(await completion.text()).toBe("data: response.completed\n\n")
  expect(codexModels).toHaveBeenCalledTimes(1)
  expect(response).toHaveBeenCalledTimes(1)
})

test("preserves upstream inference failures for Responses and Chat Completions", async () => {
  const upstream = () => Promise.resolve(new Response("upstream body", {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "application/json",
      "retry-after": "23",
      "x-upstream-request-id": "request-1",
    },
  }))
  const handler = createServer({
    health: () => Promise.resolve({ status: "upstream-unavailable" }),
    models: () => Promise.resolve({ object: "list", data: [] }),
    codexModels: () => Promise.resolve({ models: [] }),
    response: upstream,
    chatCompletion: upstream,
  })

  for (const path of ["/responses/v1/responses", "/chat/v1/chat/completions"]) {
    const result = await handler(new Request(`http://localhost${path}`, {
      method: "POST",
      body: "{}",
    }))

    expect(result.status).toBe(429)
    expect(result.statusText).toBe("Too Many Requests")
    expect(result.headers.get("retry-after")).toBe("23")
    expect(result.headers.get("x-upstream-request-id")).toBe("request-1")
    expect(await result.text()).toBe("upstream body")
  }
})

test("reports malformed local JSON as generic regardless of prior health", async () => {
  const response = mock(() => Promise.resolve(new Response()))
  const handler = createServer({
    health: () => Promise.resolve({ status: "upstream-unavailable" }),
    models: () => Promise.resolve({ object: "list", data: [] }),
    codexModels: () => Promise.resolve({ models: [] }),
    response,
    chatCompletion: () => Promise.resolve(new Response()),
  })

  const result = await handler(new Request("http://localhost/responses/v1/responses", {
    method: "POST",
    body: "{private invalid body",
  }))

  expect(result.status).toBe(502)
  expect(await result.json()).toEqual({
    error: {
      message: "Provider request failed.",
      type: "provider_error",
      code: "provider-failure",
    },
  })
  expect(response).not.toHaveBeenCalled()
})

test.each([
  {
    name: "Responses reauthentication",
    path: "/responses/v1/responses",
    failureCode: "github-credential-rejected" as const,
    status: 401,
    type: "authentication_error",
    code: "github-credential-rejected",
    message: "GitHub authentication is required.",
  },
  {
    name: "Chat Completions access rejection",
    path: "/chat/v1/chat/completions",
    failureCode: "copilot-access-rejected" as const,
    status: 403,
    type: "permission_error",
    code: "copilot-access-rejected",
    message: "GitHub Copilot access was rejected.",
  },
  {
    name: "model upstream unavailability",
    path: "/responses/v1/models",
    failureCode: "upstream-unavailable" as const,
    status: 503,
    type: "api_connection_error",
    code: "upstream-unavailable",
    message: "GitHub Copilot is temporarily unavailable.",
  },
  {
    name: "generic provider failure",
    path: "/codex/v1/models",
    failureCode: undefined,
    status: 502,
    type: "provider_error",
    code: "provider-failure",
    message: "Provider request failed.",
  },
])("returns a safe OpenAI error for $name", async ({
  path,
  failureCode,
  status,
  type,
  code,
  message,
}) => {
  const secret = "token=secret login=user@example.com C:\\private\\github-token"
  const failure = new ProviderRequestError(secret, {
    failureCode,
    retryAfter: "31",
  })
  const reject = () => Promise.reject(failure)
  const handler = createServer({
    health: () => Promise.resolve({ status: "ready" }),
    models: reject,
    codexModels: reject,
    response: reject,
    chatCompletion: reject,
  })
  const request = new Request(`http://localhost${path}`, {
    method: path.endsWith("/models") ? "GET" : "POST",
    ...(path.endsWith("/models") ? {} : { body: "{}" }),
  })

  const result = await handler(request)
  const body = await result.json()

  expect(result.status).toBe(status)
  expect(body).toEqual({ error: { message, type, code } })
  expect(JSON.stringify(body)).not.toContain(secret)
  expect(result.headers.get("retry-after")).toBe(
    code === "upstream-unavailable" ? "31" : null,
  )
  expect([...result.headers.keys()]).not.toContain("authorization")
})

test("keeps concurrent local failure classifications request-scoped", async () => {
  const handler = createServer({
    health: () => Promise.resolve({ status: "ready" }),
    models: () => Promise.resolve({ object: "list", data: [] }),
    codexModels: () => Promise.resolve({ models: [] }),
    response: async () => {
      await Bun.sleep(10)
      throw new ProviderRequestError("private auth detail", {
        failureCode: "github-credential-rejected",
      })
    },
    chatCompletion: () => Promise.reject(new ProviderRequestError(
      "private upstream detail",
      {
        failureCode: "upstream-unavailable",
        retryAfter: "7",
      },
    )),
  })

  const [auth, unavailable] = await Promise.all([
    handler(new Request("http://localhost/responses/v1/responses", {
      method: "POST",
      body: "{}",
    })),
    handler(new Request("http://localhost/chat/v1/chat/completions", {
      method: "POST",
      body: "{}",
    })),
  ])

  expect(auth.status).toBe(401)
  expect(await auth.json()).toMatchObject({
    error: { code: "github-credential-rejected" },
  })
  expect(unavailable.status).toBe(503)
  expect(unavailable.headers.get("retry-after")).toBe("7")
  expect(await unavailable.json()).toMatchObject({
    error: { code: "upstream-unavailable" },
  })
})
