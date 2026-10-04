import { expect, test } from "bun:test"

import { createChatToolNameMap, fromChatCompletion, toChatCompletion } from "../src/chat-responses.ts"

test("converts Codex history, instructions, images, tool calls and parameters without mutation", () => {
  const request = {
    model: "chat-model",
    instructions: "Follow developer instructions",
    input: [
      { role: "system", content: "System" },
      { role: "developer", content: [{ type: "input_text", text: "Developer" }] },
      { role: "user", content: [{ type: "input_text", text: "Inspect" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" }] },
      { type: "message", id: "msg_old", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Calling", annotations: [] }] },
      { type: "function_call", id: "fc_old", status: "completed", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
    tools: [{ type: "function", name: "shell", description: "Run", parameters: { type: "object", properties: {} }, strict: false }],
    tool_choice: { type: "function", name: "shell" },
    reasoning: { effort: "high" },
    stream: true,
    parallel_tool_calls: false,
    max_output_tokens: 200,
    temperature: 0.3,
    top_p: 0.9,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "cache-hint",
    client_metadata: { client: "codex" },
  }
  const original = JSON.stringify(request)
  expect(toChatCompletion(request)).toEqual({
    model: "chat-model",
    messages: [
      { role: "developer", content: "Follow developer instructions" },
      { role: "system", content: "System" },
      { role: "developer", content: [{ type: "text", text: "Developer" }] },
      { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } }] },
      { role: "assistant", content: [{ type: "text", text: "Calling" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "shell", description: "Run", parameters: { type: "object", properties: {} }, strict: false } }],
    tool_choice: { type: "function", function: { name: "shell" } },
    reasoning_effort: "high",
    stream: true,
    stream_options: { include_usage: true },
    parallel_tool_calls: false,
    max_completion_tokens: 200,
    temperature: 0.3,
    top_p: 0.9,
  })
  expect(JSON.stringify(request)).toBe(original)
  expect(toChatCompletion({ model: "m", input: "hello", tool_choice: "auto", stream: false })).toMatchObject({
    messages: [{ role: "user", content: "hello" }], tool_choice: "auto", stream: false,
  })
})

test("rejects unsupported fields and history instead of losing them", () => {
  for (const [payload, pattern] of [
    [{ model: "m", input: "hi", previous_response_id: "resp_1" }, /previous_response_id/],
    [{ model: "m", input: [{ type: "reasoning", summary: [] }] }, /reasoning/],
    [{ model: "m", input: [{ role: "user", content: [{ type: "input_audio" }] }] }, /input_audio/],
    [{ model: "m", input: [], text: { format: { type: "json_object" } } }, /request.text/],
    [{ model: "m", input: [], tools: [{ type: "custom", name: "shell" }] }, /tools\[0\]/],
    [{ model: "m", input: [], store: true }, /request.store/],
    [{ model: "m", input: [], include: ["message.output_text.logprobs"] }, /request.include/],
    [{ model: "m", input: [{ type: "function_call", status: "in_progress", call_id: "c", name: "f", arguments: "" }] }, /status/],
    [{ model: "m", input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [{ type: "url_citation" }] }] }] }, /annotations/],
  ] as const) expect(() => toChatCompletion(payload)).toThrow(pattern)
})

test("converts structured textual Codex tool results without losing text", () => {
  expect(toChatCompletion({
    model: "m",
    input: [
      { type: "function_call_output", call_id: "c1", output: [
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ] },
    ],
  })).toMatchObject({
    messages: [{ role: "tool", tool_call_id: "c1", content: "first\nsecond" }],
  })
  expect(() => toChatCompletion({
    model: "m",
    input: [{ type: "function_call_output", call_id: "c1", output: [
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
    ] }],
  })).toThrow(/output\[0\]/)
})

test("flattens live-style namespace tools and restores history and tool choice without collisions", () => {
  const namespace = (index: number) => ({
    type: "namespace",
    name: `group_${index}`,
    description: `Group ${index}`,
    tools: [
      { type: "function", name: "run", description: "Run it", parameters: { type: "object", properties: { cmd: { type: "string" } } }, defer_loading: true, strict: false },
      { type: "function", name: `inspect_${index}`, parameters: { type: "object", properties: {} } },
    ],
  })
  const request = {
    model: "gemini-chat-only",
    input: [
      { type: "function_call", namespace: "group_0", name: "run", call_id: "call_old", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "call_old", output: "ok" },
      { role: "user", content: "Continue" },
    ],
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "codex-key",
    client_metadata: { client: "codex", version: "0.159" },
    tools: [
      ...Array.from({ length: 8 }, (_, i) => ({ type: "function", name: `plain_${i}`, parameters: { type: "object", properties: {} } })),
      ...Array.from({ length: 7 }, (_, i) => namespace(i)),
      ...Array.from({ length: 3 }, (_, i) => ({ type: "function", name: `last_${i}`, defer_loading: true, parameters: { type: "object", properties: {} } })),
    ],
    tool_choice: { type: "function", namespace: "group_0", name: "run" },
    stream: true,
  }
  const original = JSON.stringify(request)
  const converted = toChatCompletion(request)
  const tools = converted["tools"] as Array<{ type: string; function: { name: string; description?: string; strict?: boolean } }>
  expect(request.tools).toHaveLength(18)
  expect(tools).toHaveLength(25)
  expect(new Set(tools.map(tool => tool.function.name)).size).toBe(25)
  expect(tools.some(tool => tool.function.name === "web_search")).toBe(false)
  expect(tools[8]).toMatchObject({
    type: "function",
    function: {
      name: "ns_8_0_run", description: "[group_0] Group 0\nRun it", strict: false,
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
  })
  const history = converted["messages"] as Array<Record<string, unknown>>
  expect(history[0]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call_old", function: { name: "ns_8_0_run", arguments: '{"cmd":"pwd"}' } }],
  })
  expect(history[1]).toMatchObject({ role: "tool", tool_call_id: "call_old", content: "ok" })
  expect(converted["tool_choice"]).toEqual({ type: "function", function: { name: "ns_8_0_run" } })
  expect(createChatToolNameMap(request).get("ns_8_0_run")).toEqual({ name: "run", namespace: "group_0" })
  expect(JSON.stringify(request)).toBe(original)
})

test("rejects unsupported namespace children, malformed definitions and forced web search", () => {
  const namespace = { type: "namespace", name: "crm", description: "CRM", tools: [{ type: "function", name: "lookup" }] }
  for (const [tools, pattern] of [
    [[{ ...namespace, tools: [{ type: "custom", name: "lookup" }] }], /tools\[0\]\.tools\[0\]\.type/],
    [[{ ...namespace, tools: [{ type: "function", name: "lookup", output_schema: {} }] }], /output_schema/],
    [[{ ...namespace, tools: [] }], /tools\[0\]\.tools/],
    [[{ ...namespace, tools: [{ type: "function", name: "lookup" }, { type: "function", name: "lookup" }] }], /Duplicate/],
    [[{ type: "tool_search" }], /tools\[0\]\.type/],
  ] as const) {
    expect(() => toChatCompletion({ model: "m", input: "hi", tools })).toThrow(pattern)
  }
  expect(() => toChatCompletion({
    model: "m", input: "hi", tools: [{ type: "web_search" }], tool_choice: "required",
  })).toThrow(/web_search is unavailable/)
  expect(() => toChatCompletion({
    model: "m", input: "hi", tools: [{ type: "web_search" }], tool_choice: { type: "function", name: "web_search" },
  })).toThrow(/web_search is unavailable/)
  expect(() => toChatCompletion({ model: "m", input: "hi", tools: [{ type: "web_search" }] })).toThrow(/web_search is unavailable/)
  expect(() => toChatCompletion({
    model: "m", input: [{ type: "function_call", namespace: "missing", name: "x", arguments: "{}", call_id: "c" }], tools: [namespace],
  })).toThrow(/Unknown/)
})

test("restores namespace identity on non-stream Chat tool calls", async () => {
  const payload = {
    model: "m", input: "find", tools: [
      { type: "namespace", name: "crm", description: "CRM", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] },
    ],
  }
  const alias = ((toChatCompletion(payload)["tools"] as Array<{ function: { name: string } }>)[0]).function.name
  const upstream = Response.json({
    choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ type: "function", id: "call_2", function: { name: alias, arguments: '{"id":2}' } }],
    } }],
  })
  const output = await (await fromChatCompletion(upstream, "m", createChatToolNameMap(payload))).json() as {
    output: Array<Record<string, unknown>>
  }
  expect(output.output[0]).toMatchObject({
    type: "function_call", name: "lookup", namespace: "crm", call_id: "call_2", arguments: '{"id":2}',
  })
})

test("converts non-stream completions with text, function calls, usage and incomplete status", async () => {
  const upstream = Response.json({
    choices: [{ finish_reason: "length", message: {
      role: "assistant", content: "Hello", tool_calls: [
        { id: "call_1", type: "function", function: { name: "shell", arguments: '{"x":1}' } },
      ],
    } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } },
  }, { status: 200, headers: { "x-trace": "abc", "content-length": "999" } })
  const converted = await fromChatCompletion(upstream, "m")
  expect(converted.status).toBe(200)
  expect(converted.headers.get("x-trace")).toBe("abc")
  expect(converted.headers.has("content-length")).toBe(false)
  const response = await converted.json() as Record<string, unknown>
  expect(response).toMatchObject({
    object: "response", model: "m", status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"x":1}' },
    ],
  })
  expect(response["id"]).toStartWith("resp_")
})

test("passes upstream errors through with original status, headers and body", async () => {
  const upstream = new Response('{"error":{"message":"rate limited"}}', {
    status: 429, statusText: "Too Many Requests",
    headers: { "retry-after": "3", "content-type": "application/json" },
  })
  const converted = await fromChatCompletion(upstream, "m")
  expect(converted).toBe(upstream)
  expect(converted.status).toBe(429)
  expect(converted.headers.get("retry-after")).toBe("3")
  expect(await converted.text()).toContain("rate limited")
})

function chatSSE(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { "content-type": "text/event-stream", "x-trace": "stream" } })
}

function events(sse: string): Record<string, unknown>[] {
  return sse.split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
    const lines = frame.split(/\r?\n/)
    const event = lines.find(line => line.startsWith("event: "))?.slice(7)
    const data = lines.find(line => line.startsWith("data: "))?.slice(6)
    if (!data) throw new Error(`Missing event data: ${frame}`)
    const parsed = JSON.parse(data) as Record<string, unknown>
    expect(parsed["type"]).toBe(event)
    return parsed
  })
}

test("streams fragmented SSE as Responses text and tool events with usage and terminal event", async () => {
  const frames = [
    ': keepalive\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n',
    'data: [DONE]\n\n',
  ].join("")
  // Fragment at every character, including inside UTF-8 and line endings.
  const upstream = chatSSE([...frames])
  const converted = await fromChatCompletion(upstream, "m")
  expect(converted.headers.get("x-trace")).toBe("stream")
  const output = events(await converted.text())
  expect(output.map(item => item["type"])).toEqual([
    "response.created", "response.in_progress", "response.output_item.added",
    "response.content_part.added", "response.output_text.delta", "response.output_text.delta",
    "response.output_item.added", "response.function_call_arguments.delta",
    "response.function_call_arguments.delta", "response.output_text.done",
    "response.content_part.done", "response.output_item.done",
    "response.function_call_arguments.done", "response.output_item.done", "response.completed",
  ])
  expect(output.filter(item => item["type"] === "response.output_text.delta").map(item => item["delta"])).toEqual(["He", "llo"])
  expect(output.filter(item => item["type"] === "response.function_call_arguments.delta").map(item => item["delta"])).toEqual(['{"cmd":', '"ls"}'])
  const final = output.at(-1)?.["response"] as Record<string, unknown>
  expect(final).toMatchObject({
    status: "completed", model: "m",
    usage: { input_tokens: 4, output_tokens: 6 },
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
    ],
  })
})

test("emits deltas before the upstream stream finishes", async () => {
  let send!: (value: string) => void
  let end!: () => void
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      send = value => controller.enqueue(new TextEncoder().encode(value))
      end = () => controller.close()
    },
  }), { headers: { "content-type": "text/event-stream" } })
  const converted = await fromChatCompletion(upstream, "m")
  const reader = converted.body!.getReader()
  await reader.read() // response.created
  await reader.read() // response.in_progress
  send('data: {"choices":[{"index":0,"delta":{"content":"now"},"finish_reason":null}]}\n\n')
  const first = await reader.read()
  const second = await reader.read()
  const third = await reader.read()
  expect([first, second, third].map(part => new TextDecoder().decode(part.value))).toContainEqual(expect.stringContaining('"delta":"now"'))
  send('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  end()
  while (!(await reader.read()).done) { /* drain */ }
})

test("reports upstream streaming errors and truncated SSE as response.failed", async () => {
  for (const fixture of [
    'event: error\ndata: {"error":{"message":"overloaded","type":"server_error"}}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"invalid":\n\n',
    'data: {"choices":[{"index":0,"delta":{"refusal":"no"},"finish_reason":null}]}\n\n',
  ]) {
    const converted = await fromChatCompletion(chatSSE([fixture]), "m")
    const output = events(await converted.text())
    expect(output.at(-1)?.["type"]).toBe("response.failed")
    expect((output.at(-1)?.["response"] as Record<string, unknown>)["status"]).toBe("failed")
  }
})

test("decodes split UTF-8, multi-line SSE data and delayed tool metadata", async () => {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":null}]}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]},"finish_reason":null}]}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"1}"}}]},"finish_reason":"length"}],\r\n',
    'data: "usage":{"prompt_tokens":1,"completion_tokens":2}}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ].join("")
  const bytes = new TextEncoder().encode(frames)
  const converted = await fromChatCompletion(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers: { "content-type": "text/event-stream" } }), "m")
  const output = events(await converted.text())
  expect(output.filter(item => item["type"] === "response.output_text.delta").map(item => item["delta"])).toEqual(["世界"])
  expect(output.filter(item => item["type"] === "response.function_call_arguments.delta").map(item => item["delta"])).toEqual(['{"a":', "1}"])
  expect(output.at(-1)).toMatchObject({
    type: "response.incomplete",
    response: {
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 1, output_tokens: 2 },
      output: [{ type: "message" }, { type: "function_call", arguments: '{"a":1}' }],
    },
  })
})

test("restores namespace on streaming tool-added, done and final response events", async () => {
  const payload = {
    model: "m",
    input: "search",
    tools: [
      { type: "function", name: "lookup" },
      { type: "namespace", name: "crm", description: "CRM", tools: [
        { type: "function", name: "lookup", parameters: { type: "object", properties: {} }, defer_loading: true },
      ] },
    ],
  }
  const alias = ((toChatCompletion(payload)["tools"] as Array<{ function: { name: string } }>)[1]).function.name
  const upstream = chatSSE([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_3", type: "function", function: { name: alias, arguments: '{"q":' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"A"}' } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ])
  const converted = await fromChatCompletion(upstream, "m", createChatToolNameMap(payload))
  const output = events(await converted.text())
  const added = output.find(item => item["type"] === "response.output_item.added")
  const done = output.find(item => item["type"] === "response.output_item.done")
  const final = output.find(item => item["type"] === "response.completed")
  for (const item of [added?.["item"], done?.["item"], (final?.["response"] as { output: unknown[] }).output[0]]) {
    expect(item).toMatchObject({ type: "function_call", namespace: "crm", name: "lookup", call_id: "call_3" })
  }
  expect(output.filter(item => item["type"] === "response.function_call_arguments.delta").map(item => item["delta"])).toEqual(['{"q":', '"A"}'])
})

test("accepts the current Codex null reasoning and JSON schema output controls", () => {
  expect(toChatCompletion({
    model: "m", input: "hi", reasoning: null, store: false, include: [],
    text: { format: { type: "json_schema", name: "result", strict: true, schema: { type: "object" } } },
  })).toEqual({
    model: "m", messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: { type: "object" } } },
  })
  expect(() => toChatCompletion({ model: "m", input: "hi", text: { verbosity: "high" } })).toThrow(/verbosity/)
})

test("keeps parallel calls together before their corresponding tool outputs", () => {
  expect(toChatCompletion({
    model: "m", input: [
      { type: "function_call", name: "a", call_id: "c1", arguments: "{}" },
      { type: "function_call", name: "b", call_id: "c2", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "one" },
      { type: "function_call_output", call_id: "c2", output: "two" },
    ],
  })).toMatchObject({
    messages: [
      { role: "assistant", tool_calls: [{ id: "c1" }, { id: "c2" }] },
      { role: "tool", tool_call_id: "c1", content: "one" },
      { role: "tool", tool_call_id: "c2", content: "two" },
    ],
  })
})

test("does not drain upstream without consumption and propagates cancellation", async () => {
  let reads = 0
  let cancelled = false
  const upstream = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"index":0,"delta":{"content":"chunk"},"finish_reason":null}]}\n\n',
      ))
    },
    cancel() { cancelled = true },
  }), { headers: { "content-type": "text/event-stream" } })
  const response = await fromChatCompletion(upstream, "m")
  await Bun.sleep(10)
  expect(reads).toBeLessThanOrEqual(1)
  const reader = response.body!.getReader()
  await reader.read()
  await reader.read()
  await reader.read()
  await reader.cancel("client disconnected")
  expect(cancelled).toBe(true)
  expect(reads).toBeLessThanOrEqual(3)
})

test("requires a finish reason before treating a Chat stream as completed", async () => {
  const response = await fromChatCompletion(chatSSE(["data: [DONE]\n\n"]), "m")
  const output = events(await response.text())
  expect(output.at(-1)).toMatchObject({ type: "response.failed" })
  expect(output.map(item => item["sequence_number"])).toEqual(output.map((_, index) => index))
})
