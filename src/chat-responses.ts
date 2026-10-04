type JsonObject = Record<string, unknown>

export interface ChatToolName {
  readonly name: string
  readonly namespace?: string
}

export type ChatToolNameMap = ReadonlyMap<string, ChatToolName>

interface ConvertedTools {
  tools: JsonObject[]
  names: Map<string, ChatToolName>
  aliases: Map<string, string>
}

function functionTool(raw: JsonObject, path: string, namespace?: string, alias?: string): JsonObject {
  allowed(raw, ["type", "name", "description", "parameters", "strict", "defer_loading"], path)
  if (raw["type"] !== "function") throw new TypeError(`Unsupported ${path}.type: ${String(raw["type"])}`)
  const name = string(raw["name"], `${path}.name`)
  if (namespace === undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new TypeError(`${path}.name must be a Chat-compatible function name`)
  }
  if (namespace !== undefined && !name) throw new TypeError(`${path}.name must not be empty`)
  const definition: JsonObject = { name: alias ?? name }
  if (raw["description"] !== undefined) {
    definition["description"] = string(raw["description"], `${path}.description`)
  }
  if (raw["defer_loading"] !== undefined && typeof raw["defer_loading"] !== "boolean") {
    throw new TypeError(`${path}.defer_loading must be a boolean`)
  }
  if (raw["parameters"] !== undefined) definition["parameters"] = object(raw["parameters"], `${path}.parameters`)
  if (raw["strict"] !== undefined) {
    if (typeof raw["strict"] !== "boolean") throw new TypeError(`${path}.strict must be a boolean`)
    definition["strict"] = raw["strict"]
  }
  return { type: "function", function: definition }
}

function toolKey(name: string, namespace?: string): string {
  return JSON.stringify([namespace ?? null, name])
}

function convertTools(request: JsonObject): ConvertedTools {
  const result: ConvertedTools = { tools: [], names: new Map(), aliases: new Map() }
  if (request["tools"] === undefined) return result
  if (!Array.isArray(request["tools"])) throw new TypeError("request.tools must be an array")
  const reserved = new Set<string>()
  for (const [index, raw] of request["tools"].entries()) {
    const path = `request.tools[${index}]`
    const tool = object(raw, path)
    if (tool["type"] === "function") {
      const name = string(tool["name"], `${path}.name`)
      if (reserved.has(name)) throw new TypeError(`Duplicate ${path}.name: ${name}`)
      reserved.add(name)
    }
  }
  for (const [index, raw] of request["tools"].entries()) {
    const path = `request.tools[${index}]`
    const tool = object(raw, path)
    if (tool["type"] === "web_search") {
      throw new TypeError(`Unsupported ${path}.type: web_search is unavailable for Chat Completions`)
    }
    if (tool["type"] === "function") {
      const name = string(tool["name"], `${path}.name`)
      result.tools.push(functionTool(tool, path))
      result.names.set(name, { name })
      result.aliases.set(toolKey(name), name)
      continue
    }
    if (tool["type"] !== "namespace") throw new TypeError(`Unsupported ${path}.type: ${String(tool["type"])}`)
    allowed(tool, ["type", "name", "description", "tools"], path)
    const namespace = string(tool["name"], `${path}.name`)
    if (!namespace) throw new TypeError(`${path}.name must not be empty`)
    const description = string(tool["description"], `${path}.description`)
    if (!Array.isArray(tool["tools"]) || tool["tools"].length === 0) {
      throw new TypeError(`${path}.tools must contain at least one function`)
    }
    for (const [childIndex, childRaw] of tool["tools"].entries()) {
      const childPath = `${path}.tools[${childIndex}]`
      const child = object(childRaw, childPath)
      if (child["type"] !== "function") throw new TypeError(`Unsupported ${childPath}.type: ${String(child["type"])}`)
      const name = string(child["name"], `${childPath}.name`)
      const key = toolKey(name, namespace)
      if (result.aliases.has(key)) throw new TypeError(`Duplicate ${childPath}.name: ${namespace}.${name}`)
      let alias = `ns_${index}_${childIndex}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64)
      if (reserved.has(alias)) alias = `ns_${index}_${childIndex}`
      if (reserved.has(alias)) throw new TypeError(`Unable to name ${childPath} without a collision`)
      reserved.add(alias)
      const converted = functionTool(child, childPath, namespace, alias)
      const definition = object(converted["function"], `${childPath}.function`)
      definition["description"] = `[${namespace}] ${description}${definition["description"] ? `\n${definition["description"]}` : ""}`
      result.tools.push(converted)
      result.names.set(alias, { name, namespace })
      result.aliases.set(key, alias)
    }
  }
  return result
}

/**
 * Pass this per-request map as the third argument to fromChatCompletion to restore
 * namespace/name on returned calls. web_search cannot be executed by Chat;
 * deferred namespace functions are advertised immediately because Chat has no tool search.
 */
export function createChatToolNameMap(payload: unknown): ChatToolNameMap {
  return convertTools(object(payload, "request")).names
}

function chatName(name: string, namespace: string | undefined, tools: ConvertedTools, path: string): string {
  const direct = tools.aliases.get(toolKey(name, namespace))
  if (direct !== undefined) return direct
  if (namespace !== undefined) throw new TypeError(`Unknown ${path}: ${namespace}.${name}`)
  for (const [alias, original] of tools.names) {
    if (original.namespace !== undefined && `${original.namespace}.${original.name}` === name) return alias
  }
  return name
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as JsonObject
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`)
  return value
}

function allowed(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`Unsupported ${path}.${key}`)
  }
}

function content(value: unknown, role: string, path: string): string | JsonObject[] {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw new TypeError(`${path} must be a string or content array`)
  const parts: JsonObject[] = []
  for (const [index, raw] of value.entries()) {
    const partPath = `${path}[${index}]`
    const part = object(raw, partPath)
    const type = part["type"]
    if (type === "input_text" || type === "output_text" || type === "text") {
      if (type === "output_text" && role !== "assistant" || type === "input_text" && role === "assistant") {
        throw new TypeError(`Unsupported ${partPath}.type for ${role}`)
      }
      allowed(part, ["type", "text", "annotations"], partPath)
      if (part["annotations"] !== undefined
        && (!Array.isArray(part["annotations"]) || part["annotations"].length !== 0)) {
        throw new TypeError(`Unsupported ${partPath}.annotations`)
      }
      parts.push({ type: "text", text: string(part["text"], `${partPath}.text`) })
    } else if (type === "input_image" && role === "user") {
      allowed(part, ["type", "image_url", "detail"], partPath)
      const image = string(part["image_url"], `${partPath}.image_url`)
      if (part["detail"] !== undefined && !["auto", "low", "high"].includes(string(part["detail"], `${partPath}.detail`))) {
        throw new TypeError(`Unsupported ${partPath}.detail`)
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: image,
          ...(part["detail"] === undefined ? {} : { detail: part["detail"] }),
        },
      })
    } else {
      throw new TypeError(`Unsupported ${partPath}.type: ${String(type)}`)
    }
  }
  return parts
}

function toolOutput(value: unknown, path: string): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw new TypeError(`${path} must be text or an array of text parts`)
  return value.map((raw, index) => {
    const partPath = `${path}[${index}]`
    const part = object(raw, partPath)
    allowed(part, ["type", "text"], partPath)
    if (!["input_text", "output_text", "text"].includes(string(part["type"], `${partPath}.type`))) {
      throw new TypeError(`Unsupported ${partPath}.type`)
    }
    return string(part["text"], `${partPath}.text`)
  }).join("\n")
}

export function toChatCompletion(payload: unknown): Record<string, unknown> {
  const request = object(payload, "request")
  allowed(request, [
    "model", "input", "instructions", "tools", "tool_choice", "reasoning", "stream",
    "max_output_tokens", "temperature", "top_p", "parallel_tool_calls", "store", "user",
    "include", "prompt_cache_key", "client_metadata",
    "text", "stream_options",
  ], "request")
  const model = string(request["model"], "request.model")
  if (request["include"] !== undefined
    && (!Array.isArray(request["include"])
      || request["include"].some(value => value !== "reasoning.encrypted_content"))) {
    throw new TypeError("Unsupported request.include")
  }
  if (request["prompt_cache_key"] !== undefined) {
    string(request["prompt_cache_key"], "request.prompt_cache_key")
  }
  if (request["client_metadata"] !== undefined) {
    object(request["client_metadata"], "request.client_metadata")
  }
  const convertedTools = convertTools(request)
  const messages: JsonObject[] = []
  if (request["instructions"] !== undefined) {
    messages.push({ role: "developer", content: string(request["instructions"], "request.instructions") })
  }
  const input = request["input"]
  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
  } else if (Array.isArray(input)) {
    for (const [index, raw] of input.entries()) {
      const path = `request.input[${index}]`
      const item = object(raw, path)
      if (item["type"] === "function_call") {
        allowed(item, ["type", "id", "status", "call_id", "name", "namespace", "arguments"], path)
        if (item["status"] !== undefined && item["status"] !== "completed") {
          throw new TypeError(`Unsupported ${path}.status: ${String(item["status"])}`)
        }
        const name = string(item["name"], `${path}.name`)
        const namespace = item["namespace"] === undefined ? undefined : string(item["namespace"], `${path}.namespace`)
        const call = {
          id: string(item["call_id"], `${path}.call_id`),
          type: "function",
          function: {
            name: chatName(name, namespace, convertedTools, `${path}.name`),
            arguments: string(item["arguments"], `${path}.arguments`),
          },
        }
        const previous = messages.at(-1)
        if (previous?.["role"] === "assistant" && Array.isArray(previous["tool_calls"])) {
          previous["tool_calls"].push(call)
        } else messages.push({
          role: "assistant",
          content: null,
          tool_calls: [call],
        })
      } else if (item["type"] === "function_call_output") {
        allowed(item, ["type", "id", "status", "call_id", "output"], path)
        if (item["status"] !== undefined && item["status"] !== "completed") {
          throw new TypeError(`Unsupported ${path}.status: ${String(item["status"])}`)
        }
        messages.push({
          role: "tool",
          tool_call_id: string(item["call_id"], `${path}.call_id`),
          content: toolOutput(item["output"], `${path}.output`),
        })
      } else if (item["type"] === undefined || item["type"] === "message") {
        allowed(item, ["type", "id", "status", "role", "content"], path)
        if (item["status"] !== undefined && item["status"] !== "completed") {
          throw new TypeError(`Unsupported ${path}.status: ${String(item["status"])}`)
        }
        const role = string(item["role"], `${path}.role`)
        if (!["system", "developer", "user", "assistant"].includes(role)) {
          throw new TypeError(`Unsupported ${path}.role: ${role}`)
        }
        if (item["type"] === "message" && item["content"] === undefined) {
          throw new TypeError(`${path}.content is required`)
        }
        messages.push({ role, content: content(item["content"], role, `${path}.content`) })
      } else {
        throw new TypeError(`Unsupported ${path}.type: ${String(item["type"])}`)
      }
    }
  } else {
    throw new TypeError("request.input must be a string or an array")
  }

  const result: JsonObject = { model, messages }
  if (request["tools"] !== undefined && convertedTools.tools.length) result["tools"] = convertedTools.tools
  const choice = request["tool_choice"]
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice)) throw new TypeError(`Unsupported request.tool_choice: ${choice}`)
      result["tool_choice"] = choice
    } else {
      const selected = object(choice, "request.tool_choice")
      allowed(selected, ["type", "name", "namespace"], "request.tool_choice")
      if (selected["type"] !== "function") throw new TypeError("Unsupported request.tool_choice.type")
      const name = string(selected["name"], "request.tool_choice.name")
      const namespace = selected["namespace"] === undefined ? undefined : string(selected["namespace"], "request.tool_choice.namespace")
      const alias = chatName(name, namespace, convertedTools, "request.tool_choice.name")
      if (!convertedTools.names.has(alias)) {
        throw new TypeError(`request.tool_choice refers to an unavailable Chat function: ${namespace ? `${namespace}.` : ""}${name}`)
      }
      result["tool_choice"] = { type: "function", function: { name: alias } }
    }
  }
  if (choice === "required" && convertedTools.tools.length === 0) {
    throw new TypeError("request.tool_choice requires a Chat-compatible tool; web_search is unavailable")
  }
  if (request["reasoning"] !== undefined && request["reasoning"] !== null) {
    const reasoning = object(request["reasoning"], "request.reasoning")
    allowed(reasoning, ["effort"], "request.reasoning")
    result["reasoning_effort"] = string(reasoning["effort"], "request.reasoning.effort")
  }
  if (request["text"] !== undefined && request["text"] !== null) {
    const text = object(request["text"], "request.text")
    allowed(text, ["format"], "request.text")
    if (text["format"] !== undefined) {
      const format = object(text["format"], "request.text.format")
      if (format["type"] === "json_schema") {
        allowed(format, ["type", "name", "schema", "strict"], "request.text.format")
        const name = string(format["name"], "request.text.format.name")
        const schema = object(format["schema"], "request.text.format.schema")
        if (format["strict"] !== undefined && typeof format["strict"] !== "boolean") {
          throw new TypeError("request.text.format.strict must be a boolean")
        }
        result["response_format"] = { type: "json_schema", json_schema: {
          name, schema, ...(format["strict"] === undefined ? {} : { strict: format["strict"] }),
        } }
      } else if (format["type"] === "text") {
        allowed(format, ["type"], "request.text.format")
      } else {
        throw new TypeError("Unsupported request.text.format.type")
      }
    }
  }
  if (request["stream_options"] !== undefined) {
    throw new TypeError("Unsupported request.stream_options")
  }
  for (const [source, target] of [
    ["max_output_tokens", "max_completion_tokens"],
    ["temperature", "temperature"],
    ["top_p", "top_p"],
  ]) {
    if (request[source] !== undefined) {
      if (typeof request[source] !== "number" || !Number.isFinite(request[source])) {
        throw new TypeError(`request.${source} must be a finite number`)
      }
      result[target] = request[source]
    }
  }
  for (const field of ["stream", "parallel_tool_calls", "store"]) {
    if (request[field] !== undefined) {
      if (typeof request[field] !== "boolean") throw new TypeError(`request.${field} must be a boolean`)
      if (field === "store" && request[field] === true) throw new TypeError("Unsupported request.store: true")
      if (field !== "store") result[field] = request[field]
    }
  }
  if (request["user"] !== undefined) result["user"] = string(request["user"], "request.user")
  if (request["stream"] === true) result["stream_options"] = { include_usage: true }
  return result
}

interface OutputState {
  id: string
  index: number
  item: JsonObject
  text: string
  arguments: string
  started: boolean
}

function responseState(model: string): JsonObject {
  return {
    id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  }
}

function usageFrom(raw: unknown): JsonObject | null {
  if (raw === undefined || raw === null) return null
  const usage = object(raw, "completion.usage")
  const input = usage["prompt_tokens"]
  const output = usage["completion_tokens"]
  if (typeof input !== "number" || typeof output !== "number") {
    throw new TypeError("completion.usage must contain numeric prompt_tokens and completion_tokens")
  }
  const details = usage["completion_tokens_details"]
  const reasoningTokens = details === undefined || details === null
    ? 0
    : object(details, "completion.usage.completion_tokens_details")["reasoning_tokens"] ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: objectOrEmpty(usage["prompt_tokens_details"])["cached_tokens"] ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : input + output,
  }
}

function objectOrEmpty(value: unknown): JsonObject {
  return value === null || value === undefined ? {} : object(value, "completion.usage details")
}

function completionOutput(message: JsonObject, names?: ChatToolNameMap): JsonObject[] {
  for (const key of ["refusal", "audio", "function_call"]) {
    if (message[key] !== undefined && message[key] !== null) {
      throw new TypeError(`Unsupported completion.message.${key}`)
    }
  }
  const output: JsonObject[] = []
  const rawContent = message["content"]
  if (typeof rawContent === "string" && rawContent.length > 0) {
    output.push({
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: rawContent, annotations: [] }],
    })
  } else if (rawContent !== null && rawContent !== undefined && rawContent !== "") {
    throw new TypeError("Unsupported completion.message.content")
  }
  if (message["tool_calls"] !== undefined) {
    if (!Array.isArray(message["tool_calls"])) throw new TypeError("completion.message.tool_calls must be an array")
    for (const [index, raw] of message["tool_calls"].entries()) {
      const call = object(raw, `completion.message.tool_calls[${index}]`)
      if (call["type"] !== "function") throw new TypeError("Unsupported completion.message.tool_calls type")
      const fn = object(call["function"], `completion.message.tool_calls[${index}].function`)
      const chatToolName = string(fn["name"], "completion.message.tool_calls.function.name")
      const original = names?.get(chatToolName)
      output.push({
        id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function_call",
        status: "completed",
        call_id: string(call["id"], "completion.message.tool_calls.id"),
        name: original?.name ?? chatToolName,
        ...(original?.namespace === undefined ? {} : { namespace: original.namespace }),
        arguments: string(fn["arguments"], "completion.message.tool_calls.function.arguments"),
      })
    }
  }
  return output
}

function responseHeaders(upstream: Response, stream: boolean): Headers {
  const headers = new Headers(upstream.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.set("content-type", stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8")
  if (stream) headers.set("cache-control", "no-cache")
  return headers
}

export async function fromChatCompletion(
  upstream: Response,
  model: string,
  toolNames?: ChatToolNameMap,
): Promise<Response> {
  if (!upstream.ok) return upstream
  if (upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    if (!upstream.body) throw new TypeError("Streaming completion has no body")
    return new Response(adaptStream(upstream.body, model, toolNames), {
      status: upstream.status, statusText: upstream.statusText,
      headers: responseHeaders(upstream, true),
    })
  }
  const completion = object(await upstream.json(), "completion")
  const choices = completion["choices"]
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new TypeError("Chat completion must contain exactly one choice")
  }
  const choice = object(choices[0], "completion.choices[0]")
  const message = object(choice["message"], "completion.choices[0].message")
  const response = responseState(model)
  response["output"] = completionOutput(message, toolNames)
  response["usage"] = usageFrom(completion["usage"])
  const reason = choice["finish_reason"]
  if (!["stop", "tool_calls", "length", "content_filter"].includes(reason as string)) {
    throw new TypeError(`Unsupported completion finish_reason: ${String(reason)}`)
  }
  response["status"] = reason === "length" || reason === "content_filter" ? "incomplete" : "completed"
  if (response["status"] === "incomplete") {
    response["incomplete_details"] = { reason: reason === "length" ? "max_output_tokens" : "content_filter" }
  }
  return new Response(JSON.stringify(response), {
    status: upstream.status, statusText: upstream.statusText,
    headers: responseHeaders(upstream, false),
  })
}

function adaptStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  toolNames?: ChatToolNameMap,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const encoder = new TextEncoder()
  const response = responseState(model)
  const items = new Map<string, OutputState>()
  let nextIndex = 0
  let finishReason: unknown
  let terminal = false
  let cancelled = false
  let released = false
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let event = ""
  const release = () => {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }
  let sequenceNumber = 0
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, type: string, fields: JsonObject) => {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber++, ...fields })}\n\n`))
  }
  const getText = (controller: ReadableStreamDefaultController<Uint8Array>): OutputState => {
    let state = items.get("text")
    if (!state) {
      state = {
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, index: nextIndex++,
        item: { type: "message", role: "assistant", status: "in_progress", content: [] },
        text: "", arguments: "", started: true,
      }
      state.item["id"] = state.id
      items.set("text", state)
      emit(controller, "response.output_item.added", { output_index: state.index, item: state.item })
      emit(controller, "response.content_part.added", {
        item_id: state.id, output_index: state.index, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      })
    }
    return state
  }
  const applyChunk = (controller: ReadableStreamDefaultController<Uint8Array>, raw: unknown) => {
    const chunk = object(raw, "chat chunk")
    if (chunk["error"] !== undefined) {
      const error = object(chunk["error"], "chat chunk.error")
      fail(controller, error)
      return
    }
    if (chunk["usage"] !== undefined) response["usage"] = usageFrom(chunk["usage"])
    const choices = chunk["choices"]
    if (!Array.isArray(choices)) throw new TypeError("chat chunk.choices must be an array")
    for (const rawChoice of choices) {
      const choice = object(rawChoice, "chat chunk.choice")
      if (choice["index"] !== 0) throw new TypeError("Only choice index 0 is supported")
      if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null) {
        finishReason = choice["finish_reason"]
      }
      const delta = object(choice["delta"], "chat chunk.choice.delta")
      for (const key of ["refusal", "audio", "function_call", "reasoning_content"]) {
        if (delta[key] !== undefined && delta[key] !== null) {
          throw new TypeError(`Unsupported chat chunk.choice.delta.${key}`)
        }
      }
      if (delta["content"] !== undefined && delta["content"] !== null) {
        const text = string(delta["content"], "chat chunk.choice.delta.content")
        if (text.length) {
          const state = getText(controller)
          state.text += text
          emit(controller, "response.output_text.delta", {
            item_id: state.id, output_index: state.index, content_index: 0, delta: text,
          })
        }
      }
      if (delta["tool_calls"] !== undefined) {
        if (!Array.isArray(delta["tool_calls"])) throw new TypeError("chat chunk.choice.delta.tool_calls must be an array")
        for (const rawCall of delta["tool_calls"]) {
          const call = object(rawCall, "chat chunk.tool_call")
          if (!Number.isInteger(call["index"])) throw new TypeError("chat chunk.tool_call.index must be an integer")
          const key = `tool:${call["index"]}`
          let state = items.get(key)
          if (!state) {
            state = {
              id: `fc_${crypto.randomUUID().replaceAll("-", "")}`, index: nextIndex++,
              item: { type: "function_call", status: "in_progress", call_id: "", name: "", arguments: "" },
              text: "", arguments: "", started: false,
            }
            state.item["id"] = state.id
            items.set(key, state)
          }
          if (call["type"] !== undefined && call["type"] !== "function") throw new TypeError("Unsupported chat tool call type")
          if (call["id"] !== undefined) state.item["call_id"] = string(call["id"], "chat chunk.tool_call.id")
          if (call["function"] !== undefined) {
            const fn = object(call["function"], "chat chunk.tool_call.function")
            if (fn["name"] !== undefined) {
              const chatToolName = string(fn["name"], "chat chunk.tool_call.function.name")
              const original = toolNames?.get(chatToolName)
              state.item["name"] = original?.name ?? chatToolName
              if (original?.namespace !== undefined) state.item["namespace"] = original.namespace
            }
            if (!state.started && state.item["call_id"] && state.item["name"]) {
              state.started = true
              emit(controller, "response.output_item.added", { output_index: state.index, item: state.item })
              if (state.arguments) {
                emit(controller, "response.function_call_arguments.delta", {
                  item_id: state.id, output_index: state.index, delta: state.arguments,
                })
              }
            }
            if (fn["arguments"] !== undefined) {
              const part = string(fn["arguments"], "chat chunk.tool_call.function.arguments")
              state.arguments += part
              if (state.started && part) {
                emit(controller, "response.function_call_arguments.delta", {
                  item_id: state.id, output_index: state.index, delta: part,
                })
              }
            }
          }
        }
      }
    }
  }
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: JsonObject) => {
    if (terminal) return
    terminal = true
    response["status"] = "failed"
    response["error"] = error
    emit(controller, "response.failed", { response })
  }
  const complete = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminal) return
    for (const state of [...items.values()].sort((a, b) => a.index - b.index)) {
      if (!state.started) {
        if (!state.item["call_id"] || !state.item["name"]) throw new TypeError("Incomplete streaming tool call metadata")
        state.started = true
        emit(controller, "response.output_item.added", { output_index: state.index, item: state.item })
        if (state.arguments) emit(controller, "response.function_call_arguments.delta", {
          item_id: state.id, output_index: state.index, delta: state.arguments,
        })
      }
      if (state.item["type"] === "message") {
        emit(controller, "response.output_text.done", {
          item_id: state.id, output_index: state.index, content_index: 0, text: state.text,
        })
        const part = { type: "output_text", text: state.text, annotations: [] }
        emit(controller, "response.content_part.done", {
          item_id: state.id, output_index: state.index, content_index: 0, part,
        })
        state.item["content"] = [part]
      } else {
        if (state.arguments) {
          // Arguments received before the tool's metadata must still be delivered incrementally.
          state.item["arguments"] = state.arguments
        }
        emit(controller, "response.function_call_arguments.done", {
          item_id: state.id, output_index: state.index, arguments: state.arguments,
        })
      }
      state.item["status"] = "completed"
      emit(controller, "response.output_item.done", { output_index: state.index, item: state.item })
    }
    response["output"] = [...items.values()].sort((a, b) => a.index - b.index).map(state => state.item)
    if (!["stop", "tool_calls", "length", "content_filter"].includes(finishReason as string)) {
      throw new TypeError(`Unsupported chat finish_reason: ${String(finishReason)}`)
    }
    response["status"] = finishReason === "length" ? "incomplete" : "completed"
    if (finishReason === "content_filter") response["status"] = "incomplete"
    if (response["status"] === "incomplete") {
      response["incomplete_details"] = {
        reason: finishReason === "length" ? "max_output_tokens" : "content_filter",
      }
    }
    terminal = true
    emit(controller, response["status"] === "incomplete" ? "response.incomplete" : "response.completed", { response })
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      emit(controller, "response.created", { response: { ...response } })
      emit(controller, "response.in_progress", { response: { ...response } })
    },
    async pull(controller) {
      const dispatch = () => {
        if (!data.length) { event = ""; return }
        const payload = data.join("\n")
        data = []
        const kind = event
        event = ""
        if (payload === "[DONE]") {
          complete(controller)
        } else if (kind === "error") {
          const parsed = object(JSON.parse(payload), "chat SSE error")
          fail(controller, parsed["error"] === undefined ? parsed : object(parsed["error"], "chat SSE error.error"))
        } else if (!terminal) {
          applyChunk(controller, JSON.parse(payload))
        }
      }
      const process = (eof: boolean) => {
        while (true) {
          const match = /\r\n|\r|\n/.exec(buffer)
          if (!match) break
          if (match[0] === "\r" && match.index === buffer.length - 1 && !eof) break
          const line = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          if (line === "") dispatch()
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
          else if (line.startsWith("event:")) event = line.slice(6).trimStart()
        }
        if (eof) {
          if (buffer) {
            if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""))
            else if (buffer.startsWith("event:")) event = buffer.slice(6).trimStart()
          }
          dispatch()
        }
      }
      try {
        while (!terminal) {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            buffer += decoder.decode()
            process(true)
            if (!terminal) throw new TypeError("Chat SSE ended without [DONE]")
            break
          }
          buffer += decoder.decode(value, { stream: true })
          process(false)
          if (!terminal && (controller.desiredSize ?? 0) <= 0) return
        }
      } catch (error) {
        if (cancelled) return
        fail(controller, { type: "upstream_stream_error", message: error instanceof Error ? error.message : String(error) })
      }
      if (terminal) {
        await reader.cancel()
        if (cancelled) return
        release()
        controller.close()
      }
    },
    async cancel(reason) {
      terminal = true
      cancelled = true
      await reader.cancel(reason)
      release()
    },
  })
}
