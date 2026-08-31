import { afterEach, expect, mock, test } from "bun:test"

import { CopilotClient } from "../src/copilot.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("lists protocol-compatible models with capabilities reported by Copilot", async () => {
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
              supports: {
                reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
                vision: true,
              },
              limits: {
                max_context_window_tokens: 1_050_000,
                max_output_tokens: 128_000,
              },
            },
          },
          {
            id: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            model_picker_enabled: true,
            supported_endpoints: ["chat/completions"],
            capabilities: {
              supports: {
                reasoning_effort: ["low", "medium", "high"],
                vision: true,
              },
              limits: {
                max_context_window_tokens: 1_000_000,
                max_output_tokens: 64_000,
              },
            },
          },
        ],
      }))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const client = new CopilotClient("github-token")
  const responses = await client.models("responses")
  const chat = await client.models("chat-completions")

  expect(responses).toEqual({
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
      input: ["text", "image"],
      reasoning_efforts: {
        off: "none",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }],
    has_more: false,
  })
  expect(chat).toEqual({
    object: "list",
    data: [{
      id: "gemini-3.7-flash",
      object: "model",
      type: "model",
      created: 0,
      owned_by: "GitHub Copilot",
      display_name: "Gemini 3.7 Flash",
      context_window: 1_000_000,
      max_output_tokens: 64_000,
      input: ["text", "image"],
      reasoning_efforts: {
        low: "low",
        medium: "medium",
        high: "high",
      },
    }],
    has_more: false,
  })
})

test("marks a tool continuation as agent-initiated and makes non-strict tools explicit", async () => {
  const parameters = {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string" },
      sandbox_permissions: { type: "string" },
      justification: { type: "string" },
    },
    required: ["command", "description"],
  }
  const payload = {
    model: "gpt-5.6-sol",
    input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
    tools: [{
      type: "function",
      name: "pwsh",
      description: "Execute PowerShell",
      parameters,
    }],
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
    expect(JSON.parse(init.body)).toEqual({
      ...payload,
      tools: [{ ...payload.tools[0], strict: false }],
    })
    expect(parameters.required).toEqual(["command", "description"])
    return Promise.resolve(new Response([
      "data: {\"type\":\"response.function_call_arguments.done\",",
      "\"arguments\":\"{\\\"command\\\":\\\"Get-Location\\\",",
      "\\\"description\\\":\\\"Inspect location\\\",",
      "\\\"sandbox_permissions\\\":\\\"workspace-write\\\",",
      "\\\"justification\\\":\\\"Retry after denial\\\"}\"}\n\n",
    ].join("")))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await new CopilotClient("github-token").response(payload)

  expect(await response.text()).toContain("\\\"sandbox_permissions\\\":\\\"workspace-write\\\"")
  expect(payload.tools[0]).not.toHaveProperty("strict")
})

test("preserves explicit strict modes and non-tool Responses payloads", async () => {
  const requests: unknown[] = []
  const fetchMock = mock((url: string, init?: RequestInit) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(Response.json({
        token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
    requests.push(JSON.parse(init.body))
    return Promise.resolve(new Response("data: response.completed\n\n"))
  })

  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("github-token")
  const strictTools = {
    model: "gpt-5.6-sol",
    input: "Use the tool",
    tools: [
      { type: "function", name: "strict_tool", parameters: {}, strict: true },
      { type: "function", name: "loose_tool", parameters: {}, strict: false },
      { type: "custom", name: "grammar_tool", format: { type: "grammar" } },
    ],
  }
  const imageInput = {
    model: "gpt-5.6-sol",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    }],
  }

  await client.response(strictTools)
  await client.response(imageInput)

  expect(requests).toEqual([strictTools, imageInput])
})

test("passes Chat Completions reasoning and images from every turn unchanged", async () => {
  const payload = {
    model: "gemini-3.7-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "First image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "Seen" },
      {
        role: "user",
        content: [
          { type: "text", text: "Second image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      },
    ],
    reasoning_effort: "high",
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
    expect(url).toBe("https://api.githubcopilot.com/chat/completions")
    expect(new Headers(init?.headers).get("x-initiator")).toBe("agent")
    if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
    expect(JSON.parse(init.body)).toEqual(payload)
    return Promise.resolve(new Response("data: [DONE]\n\n"))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await new CopilotClient("github-token").chatCompletion(payload)

  expect(await response.text()).toBe("data: [DONE]\n\n")
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

test("reloads the GitHub token and retries once after an authorization failure", async () => {
  const githubTokens = ["github-token-1", "github-token-2"]
  let tokenReads = 0
  let exchanges = 0
  let responses = 0
  const fetchMock = mock((url: string, init?: RequestInit) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      const authorization = new Headers(init?.headers).get("authorization")
      exchanges += 1
      expect(authorization).toBe(`token ${githubTokens[exchanges - 1]}`)
      return Promise.resolve(Response.json({
        token: `session-token-${exchanges}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    if (url === "https://api.githubcopilot.com/responses") {
      responses += 1
      const authorization = new Headers(init?.headers).get("authorization")
      expect(authorization).toBe(`Bearer session-token-${responses}`)
      return Promise.resolve(responses === 1
        ? new Response("expired", { status: 401 })
        : new Response("ok"))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient(() =>
    Promise.resolve(githubTokens[tokenReads++] ?? "unexpected-token"))

  const response = await client.response({ input: "hello" })

  expect(await response.text()).toBe("ok")
  expect(tokenReads).toBe(2)
  expect(exchanges).toBe(2)
  expect(responses).toBe(2)
})

test("surfaces a rejected GitHub credential without exposing the upstream body", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response("sensitive upstream detail", { status: 401 })))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("invalid-github-token")

  expect(await client.health()).toMatchObject({
    status: "reauth-required",
    code: "github-credential-rejected",
  })
  expect(JSON.stringify(await client.health())).not.toContain("sensitive")
})

test("surfaces and revalidates Copilot API availability with a cached session", async () => {
  let modelRequests = 0
  const fetchMock = mock((url: string) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(Response.json({
        token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    if (url === "https://api.githubcopilot.com/models") {
      modelRequests += 1
      return Promise.resolve(modelRequests === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ data: [] }))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("github-token")

  await expect(client.models()).rejects.toThrow("Copilot request failed (503)")
  expect(await client.health()).toMatchObject({ status: "ready" })
  expect(modelRequests).toBe(2)
})

test("refreshes after an authorization failure during health revalidation", async () => {
  let exchanges = 0
  let modelRequests = 0
  const fetchMock = mock((url: string) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      exchanges += 1
      return Promise.resolve(exchanges === 1
        ? Response.json({
            token: "session-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1500,
          })
        : new Response("credential rejected", { status: 401 }))
    }
    if (url === "https://api.githubcopilot.com/models") {
      modelRequests += 1
      return Promise.resolve(modelRequests === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("session rejected", { status: 401 }))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("github-token")

  await expect(client.models()).rejects.toThrow("Copilot request failed (503)")
  expect(await client.health()).toMatchObject({
    status: "reauth-required",
    code: "github-credential-rejected",
  })
  expect(exchanges).toBe(2)
})

test("detects a replacement GitHub credential on the next health check", async () => {
  let exchanges = 0
  let modelRequests = 0
  const fetchMock = mock((url: string) => {
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      exchanges += 1
      return Promise.resolve(Response.json({
        token: `session-token-${exchanges}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1500,
      }))
    }
    if (url === "https://api.githubcopilot.com/models") {
      modelRequests += 1
      return Promise.resolve(modelRequests <= 2
        ? new Response("session rejected", { status: 401 })
        : Response.json({ data: [] }))
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const client = new CopilotClient("github-token")

  await expect(client.models()).rejects.toThrow("Copilot request failed (401)")
  expect(await client.health()).toMatchObject({ status: "ready" })
  expect(exchanges).toBe(3)
})
