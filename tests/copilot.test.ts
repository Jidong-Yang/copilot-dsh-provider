import { afterEach, expect, mock, test } from "bun:test"

import { CopilotClient } from "../src/copilot.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("lists only Responses-compatible models with reported capacities", async () => {
  const fetchMock = mock((url: string) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(Response.json({
        token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    if (url === "https://api.githubcopilot.com/models") {
      return Promise.resolve(Response.json({
        data: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            vendor: "OpenAI",
            supported_endpoints: ["responses"],
            capabilities: {
              limits: {
                max_context_window_tokens: 1_050_000,
                max_output_tokens: 128_000,
              },
            },
          },
          {
            id: "legacy-chat",
            supported_endpoints: ["chat/completions"],
          },
        ],
      }))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await new CopilotClient("github-token").models()

  expect(result).toEqual({
    object: "list",
    data: [{
      id: "gpt-5.6-sol",
      object: "model",
      type: "model",
      created: 0,
      owned_by: "OpenAI",
      display_name: "GPT-5.6 Sol",
      context_window: 1_050_000,
      max_output_tokens: 128_000,
    }],
    has_more: false,
  })
})

test("marks a tool continuation as agent-initiated without changing its body", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
    stream: true,
  }
  const fetchMock = mock((url: string, init?: RequestInit) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(Response.json({
        token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    expect(url).toBe("https://api.githubcopilot.com/responses")
    expect(new Headers(init?.headers).get("x-initiator")).toBe("agent")
    if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
    expect(JSON.parse(init.body)).toEqual(payload)
    return Promise.resolve(new Response("data: response.completed\n\n"))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await new CopilotClient("github-token").response(payload)

  expect(await response.text()).toBe("data: response.completed\n\n")
})

test("shares one token exchange across concurrent first requests", async () => {
  let exchanges = 0
  const fetchMock = mock(async (url: string) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      exchanges += 1
      await Bun.sleep(10)
      return Response.json({
        token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      })
    }
    if (url === "https://api.githubcopilot.com/models") {
      return Response.json({ data: [] })
    }
    if (url === "https://api.githubcopilot.com/responses") {
      return new Response("ok")
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("github-token")

  await Promise.all([client.models(), client.response({ input: "hello" })])

  expect(exchanges).toBe(1)
})
