import type { CopilotProtocol } from "./copilot.ts"
import { failureCodeFrom, retryAfterFrom } from "./errors.ts"
import { buildIdentity } from "./build-identity.ts" with { type: "macro" }
import { CodexRequestError, readCodexRequest } from "./codex-request.ts"
import { errorLog } from "./log.ts"
import type { RequestLogger } from "./log.ts"
import { Instrumentation } from "./instrumentation.ts"
import type { RequestContext } from "./instrumentation.ts"

const identity = buildIdentity()

export interface Provider {
  health: (signal?: AbortSignal) => Promise<object>
  models: (protocol: CopilotProtocol, signal?: AbortSignal, context?: RequestContext) => Promise<object>
  codexModels: (signal?: AbortSignal, context?: RequestContext) => Promise<object>
  response: (payload: unknown, signal?: AbortSignal, context?: RequestContext) => Promise<Response>
  codexResponse?: (payload: unknown, signal?: AbortSignal, context?: RequestContext) => Promise<Response>
  chatCompletion: (payload: unknown, signal?: AbortSignal, context?: RequestContext) => Promise<Response>
  onHealthChange?: (listener: (health: object, requestId?: string) => void) => void
}

const HEALTH_PATHS = new Set(["/health", "/health/version", "/health/live", "/health/ready", "/health/metrics"])

export function createServer(
  client: Provider,
  logger?: RequestLogger,
  instrumentation = new Instrumentation(logger),
): (request: Request) => Promise<Response> {
  client.onHealthChange?.((health, requestId) => instrumentation.observeDependency(health, requestId))
  const dispatch = async (request: Request, context?: RequestContext): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health/version") {
      if (identity === null) {
        return Response.json({
          error: {
            message: "Provider build identity is unavailable.",
            type: "provider_error",
            code: "build-identity-unavailable",
          },
        }, { status: 503 })
      }
      return Response.json({
        schemaVersion: 1,
        status: "ready",
        repository: "Jidong-Yang/copilot-dsh-provider",
        version: identity.version,
        revision: identity.revision,
      })
    }
    if (request.method === "GET" && url.pathname === "/health/metrics") {
      return Response.json(instrumentation.snapshot())
    }
    if (request.method === "GET" && url.pathname === "/health/live") {
      return Response.json({ status: "live", uptimeMs: instrumentation.snapshot().uptimeMs })
    }
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/ready")) {
      const health = await client.health(request.signal)
      instrumentation.observeDependency(health)
      const ready = "status" in health && health.status === "ready"
      return Response.json(health, { status: url.pathname === "/health/ready" && !ready ? 503 : 200 })
    }
    if (request.method === "GET" && url.pathname === "/codex/v1/models") {
      context?.setSource("upstream")
      return Response.json(await client.codexModels(request.signal, context))
    }
    const protocol = modelProtocol(url.pathname)
    if (request.method === "GET" && protocol !== undefined) {
      context?.setSource("upstream")
      return Response.json(await client.models(protocol, request.signal, context))
    }
    const operation = responseOperation(url.pathname)
    if (request.method === "POST" && url.pathname === "/codex/v1/responses/compact") {
      context?.setFailure("remote_compaction_unsupported", "rejected")
      return codexErrorResponse(new CodexRequestError(501, "remote_compaction_unsupported",
        "Use the GitHub Copilot provider configuration. Codex performs local compaction through /responses; encrypted remote compaction is not supported."))
    }
    if (request.method === "POST" && operation !== undefined) {
      const codex = url.pathname === "/codex/v1/responses"
      let payload: unknown
      try {
        if (codex) {
          const parsed = await readCodexRequest(request)
          payload = parsed.payload
          context?.setRequestBytes(parsed.requestBytes)
        } else {
          const bytes = await request.arrayBuffer()
          context?.setRequestBytes(bytes.byteLength)
          payload = JSON.parse(new TextDecoder().decode(bytes))
        }
      } catch (error) {
        const invalid = error instanceof CodexRequestError || error instanceof SyntaxError
        context?.setFailure(error instanceof CodexRequestError ? error.code : invalid ? "invalid_json" : "request_body_error",
          invalid ? "rejected" : undefined)
        if (error instanceof CodexRequestError && error.requestBytes !== undefined) {
          context?.setRequestBytes(error.requestBytes)
        }
        throw error
      }
      if (codex) {
        if (!client.codexResponse) throw new CodexRequestError(503, "codex_adapter_unavailable",
          "The provider does not have a Codex adapter configured.")
        context?.setSource("upstream")
        return await client.codexResponse(payload, request.signal, context)
      }
      context?.setSource("upstream")
      return operation === "responses"
        ? await client.response(payload, request.signal, context)
        : await client.chatCompletion(payload, request.signal, context)
    }
    return Response.json({ error: { message: "Not found", type: "not_found" } }, {
      status: 404,
    })
  }
  return async request => {
    const url = new URL(request.url)
    const health = request.method === "GET" && HEALTH_PATHS.has(url.pathname)
    const knownRoute = responseOperation(url.pathname) !== undefined || modelProtocol(url.pathname) !== undefined
      || url.pathname === "/codex/v1/models" || url.pathname === "/codex/v1/responses/compact"
    const context = health ? undefined : await instrumentation.begin(request, knownRoute ? url.pathname : "/unknown")
    let response: Response
    try {
      response = await dispatch(request, context)
    } catch (error) {
      context?.setSource("provider")
      if (error instanceof CodexRequestError) {
        context?.setFailure(error.code, error.status >= 400 && error.status < 500 ? "rejected" : undefined)
        response = codexErrorResponse(error)
      } else {
        if (!(error instanceof SyntaxError)) context?.setFailure(errorLog(error).category ?? "provider-failure")
        response = errorResponse(error)
      }
    }
    return context ? await context.response(response, responseOperation(url.pathname)) : response
  }
}

function codexErrorResponse(error: CodexRequestError): Response {
  return Response.json({
    error: { message: error.message, type: error.status >= 500 ? "provider_error" : "invalid_request_error", code: error.code,
      ...(error.param === undefined ? {} : { param: error.param }) },
  }, { status: error.status, headers: { "x-provider-error-source": "provider" } })
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
