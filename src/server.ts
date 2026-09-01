import type { CopilotProtocol } from "./copilot.ts"
import { failureCodeFrom, retryAfterFrom } from "./errors.ts"

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
      let payload: unknown
      try {
        payload = await request.json()
      } catch (error) {
        return errorResponse(error)
      }
      try {
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

interface LocalFailure {
  status: number
  message: string
  type: string
  code: string
  transient: boolean
}

function errorResponse(error: unknown): Response {
  const failure = localFailure(failureCodeFrom(error))
  const retryAfter = failure.transient ? retryAfterFrom(error) : undefined
  return Response.json({
    error: {
      message: failure.message,
      type: failure.type,
      code: failure.code,
    },
  }, {
    status: failure.status,
    headers: retryAfter === undefined ? undefined : { "retry-after": retryAfter },
  })
}

function localFailure(code: ReturnType<typeof failureCodeFrom>): LocalFailure {
  if (code === "copilot-access-rejected") {
    return {
      status: 403,
      message: "GitHub Copilot access was rejected.",
      type: "permission_error",
      code: "copilot-access-rejected",
      transient: false,
    }
  }
  if (code === "github-credential-rejected") {
    return {
      status: 401,
      message: "GitHub authentication is required.",
      type: "authentication_error",
      code: "github-credential-rejected",
      transient: false,
    }
  }
  if (code === "upstream-unavailable") {
    return {
      status: 503,
      message: "GitHub Copilot is temporarily unavailable.",
      type: "api_connection_error",
      code: "upstream-unavailable",
      transient: true,
    }
  }
  return {
    status: 502,
    message: "Provider request failed.",
    type: "provider_error",
    code: "provider-failure",
    transient: false,
  }
}
