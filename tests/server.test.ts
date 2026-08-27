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
    response: () => Promise.resolve(new Response()),
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
