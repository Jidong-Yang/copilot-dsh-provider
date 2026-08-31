import { expect, mock, test } from "bun:test"

import { createServer } from "../src/server.ts"
import type { Provider } from "../src/server.ts"

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
