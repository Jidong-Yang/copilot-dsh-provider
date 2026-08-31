import type { CopilotProtocol } from "./copilot.ts"

export interface Provider {
  health: (signal?: AbortSignal) => Promise<object>
  models: (protocol: CopilotProtocol, signal?: AbortSignal) => Promise<object>
  codexModels: (signal?: AbortSignal) => Promise<object>
  response: (payload: unknown, signal?: AbortSignal) => Promise<Response>
  chatCompletion: (payload: unknown, signal?: AbortSignal) => Promise<Response>
}

export function createServer(client: Provider): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(await client.health(request.signal))
    }
    if (request.method === "GET" && url.pathname === "/codex/v1/models") {
      try {
        return Response.json(await client.codexModels(request.signal))
      } catch (error) {
        return errorResponse(error)
      }
    }
    const protocol = modelProtocol(url.pathname)
    if (request.method === "GET" && protocol !== undefined) {
      try {
        return Response.json(await client.models(protocol, request.signal))
      } catch (error) {
        return errorResponse(error)
      }
    }
    const operation = responseOperation(url.pathname)
    if (request.method === "POST" && operation !== undefined) {
      try {
        const payload = await request.json()
        const upstream = operation === "responses"
          ? await client.response(payload, request.signal)
          : await client.chatCompletion(payload, request.signal)
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        })
      } catch (error) {
        return errorResponse(error)
      }
    }
    return Response.json({ error: { message: "Not found", type: "not_found" } }, {
      status: 404,
    })
  }
}

function modelProtocol(path: string): CopilotProtocol | undefined {
  if (
    path === "/v1/models"
    || path === "/responses/v1/models"
  ) return "responses"
  if (path === "/chat/v1/models") return "chat-completions"
  return undefined
}

function responseOperation(path: string): CopilotProtocol | undefined {
  if (
    path === "/v1/responses"
    || path === "/responses/v1/responses"
    || path === "/codex/v1/responses"
  ) return "responses"
  if (path === "/v1/chat/completions" || path === "/chat/v1/chat/completions") {
    return "chat-completions"
  }
  return undefined
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: { message, type: "provider_error" } }, {
    status: 502,
  })
}
