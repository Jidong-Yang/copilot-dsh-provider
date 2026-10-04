import { copilotHeaders, githubHeaders } from "./config.ts"
import { GitHubCredentialUnavailableError } from "./auth.ts"
import {
  classifyProviderError,
  failureCodeFrom,
  ProviderRequestError,
  validRetryAfter,
} from "./errors.ts"
import type { ProviderFailureCode } from "./errors.ts"
import { createChatToolNameMap, fromChatCompletion, toChatCompletion } from "./chat-responses.ts"
import { CodexRequestError } from "./codex-request.ts"
import type { RequestLogger } from "./log.ts"
import type { RequestContext } from "./instrumentation.ts"

interface SessionTokenReply {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: { api?: string }
}

interface CopilotModel {
  id: string
  name?: string
  vendor?: string
  model_picker_enabled?: boolean
  supported_endpoints?: string[]
  capabilities?: {
    supports?: {
      reasoning_effort?: string[]
      vision?: boolean
    }
    limits?: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
      max_output_tokens?: number
    }
  }
}

interface ModelsReply {
  data: CopilotModel[]
}

const CODEX_BASE_INSTRUCTIONS = [
  "You are an autonomous coding agent working in the user's repository.",
  "Follow system, developer, and user instructions in precedence order, and read applicable repository guidance before changing files.",
  "Inspect the relevant code and use the available tools to perform the requested work instead of only describing a solution.",
  "Make precise changes, preserve existing user work, avoid unrelated modifications, and do not use destructive git operations unless explicitly requested.",
  "Keep credentials and sensitive data private, and respect sandbox and approval boundaries.",
  "For code changes, run the smallest relevant tests, type checks, or builds and fix failures caused by your work.",
  "Verify the requested outcome before claiming completion.",
  "In the final response, concisely state the result and any genuine limitation.",
].join(" ")

type GitHubTokenSource = string | ((forceRefresh?: boolean) => Promise<string>)

export type CopilotProtocol = "chat-completions" | "responses"

export interface ModelHealth {
  status: "checking" | "ready" | "reauth-required" | "upstream-unavailable"
  code?: "github-credential-rejected" | "copilot-access-rejected" | "upstream-unavailable"
  observedAt: string
}

export class CopilotClient {
  private session?: { token: string; expiresAt: number; apiBase: string }
  private pendingSession?: Promise<{ token: string; expiresAt: number; apiBase: string }>
  private codexModelCache?: { models: CopilotModel[]; expiresAt: number }
  private readonly healthListeners = new Set<(health: object, requestId?: string) => void>()
  private modelHealth: ModelHealth = {
    status: "checking",
    observedAt: new Date().toISOString(),
  }

  public constructor(
    private readonly githubTokenSource: GitHubTokenSource,
    private readonly logger?: RequestLogger,
  ) {}

  public onHealthChange(listener: (health: object, requestId?: string) => void): void {
    this.healthListeners.add(listener)
    listener(this.modelHealth)
  }

  public async health(signal?: AbortSignal): Promise<ModelHealth> {
    try {
      await this.sessionToken()
      if (this.modelHealth.status === "upstream-unavailable") {
        const response = await this.requestWithSession(session =>
          fetch(`${session.apiBase}/models`, {
            headers: copilotHeaders(session.token, false),
            signal,
          }), signal)
        await response.body?.cancel()
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (this.modelHealth.status !== "reauth-required") {
        this.setHealth("upstream-unavailable", "upstream-unavailable")
      }
    }
    return this.modelHealth
  }

  public async models(
    protocol: CopilotProtocol = "responses",
    signal?: AbortSignal,
    context?: RequestContext,
  ): Promise<object> {
    const upstream = await this.fetchModels(signal, context)
    return {
      object: "list",
      data: upstream.data
        .filter(model => model.model_picker_enabled !== false)
        .filter(model => supportsProtocol(model, protocol))
        .map(model => {
          const limits = model.capabilities?.limits
          const reasoningEfforts = model.capabilities?.supports?.reasoning_effort
          return {
            id: model.id,
            object: "model",
            type: "model",
            created: 0,
            owned_by: model.vendor ?? "GitHub Copilot",
            display_name: model.name ?? model.id,
            ...(limits?.max_context_window_tokens === undefined
              ? {}
              : { context_window: limits.max_context_window_tokens }),
            ...(limits?.max_output_tokens === undefined
              ? {}
              : { max_output_tokens: limits.max_output_tokens }),
            ...(model.capabilities?.supports?.vision === true
              ? { input: ["text", "image"] }
              : {}),
            ...(reasoningEfforts === undefined
              ? {}
              : { reasoning_efforts: normalizeReasoningEfforts(reasoningEfforts) }),
          }
        }),
      has_more: false,
    }
  }

  public async codexModels(signal?: AbortSignal, context?: RequestContext): Promise<object> {
    const models = (await this.codexModelsForRouting(signal, context))
      .filter(model => model.model_picker_enabled !== false)
      .filter(model => supportsProtocol(model, "responses") || supportsProtocol(model, "chat-completions"))

    return {
      models: models.map((model, index) => {
        const efforts = model.capabilities?.supports?.reasoning_effort ?? []
        const contextWindow = model.capabilities?.limits?.max_context_window_tokens
        const promptLimit = model.capabilities?.limits?.max_prompt_tokens
        const outputLimit = model.capabilities?.limits?.max_output_tokens ?? 0
        const compactLimit = contextWindow === undefined ? undefined : Math.max(1, Math.min(
          Math.floor(contextWindow * 0.9),
          contextWindow - outputLimit,
          promptLimit ?? contextWindow,
        ))
        return {
          slug: model.id,
          display_name: model.name ?? model.id,
          description: `${model.name ?? model.id} through GitHub Copilot`,
          default_reasoning_level: preferredReasoningEffort(efforts),
          supported_reasoning_levels: efforts.map(effort => ({
            effort,
            description: reasoningEffortDescription(effort),
          })),
          shell_type: "unified_exec",
          visibility: "list",
          supported_in_api: true,
          priority: models.length - index,
          availability_nux: null,
          upgrade: null,
          base_instructions: CODEX_BASE_INSTRUCTIONS,
          model_messages: { instructions_template: CODEX_BASE_INSTRUCTIONS },
          supports_reasoning_summary_parameter: false,
          support_verbosity: false,
          default_verbosity: null,
          apply_patch_tool_type: null,
          truncation_policy: { mode: "bytes", limit: 10_000 },
          ...(contextWindow === undefined
            ? {}
            : {
                context_window: contextWindow,
                max_context_window: contextWindow,
                auto_compact_token_limit: compactLimit,
              }),
          effective_context_window_percent: 95,
          supports_search_tool: false,
          experimental_supported_tools: [],
          input_modalities: model.capabilities?.supports?.vision === true
            ? ["text", "image"]
            : ["text"],
        }
      }),
    }
  }

  public async response(payload: unknown, signal?: AbortSignal, context?: RequestContext): Promise<Response> {
    return await this.request("responses", withExplicitNonStrictTools(payload), signal, context)
  }

  public async codexResponse(payload: unknown, signal?: AbortSignal, context?: RequestContext): Promise<Response> {
    if (!isRecord(payload) || typeof payload["model"] !== "string" || !payload["model"].trim()) {
      throw new CodexRequestError(400, "invalid_request_error", "A non-empty model is required.", "model")
    }
    if (payload["store"] === true || payload["previous_response_id"] !== undefined) {
      throw new CodexRequestError(400, "unsupported_stateful_request",
        "Codex requests must contain full history and use store: false.")
    }
    const models = await this.codexModelsForRouting(signal, context)
    const model = models.find(model => model.id === payload["model"] && model.model_picker_enabled !== false)
    if (!model) throw new CodexRequestError(400, "model_not_found",
      "The selected model is not in the Copilot catalog. Regenerate the Codex model catalog.", "model")
    let protocol: CopilotProtocol
    let upstreamPayload: unknown
    let names: ReturnType<typeof createChatToolNameMap> | undefined
    if (supportsProtocol(model, "responses")) {
      protocol = "responses"
      upstreamPayload = withExplicitNonStrictTools(payload)
    } else if (supportsProtocol(model, "chat-completions")) {
      protocol = "chat-completions"
      try {
        names = createChatToolNameMap(payload)
        upstreamPayload = toChatCompletion(withExplicitNonStrictTools(payload))
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        throw new CodexRequestError(400, "unsupported_codex_request",
          "This request cannot be represented by the selected Chat Completions model. Use a Responses model or disable unsupported tools.")
      }
    } else {
      throw new CodexRequestError(400, "unsupported_model_protocol", "The selected model has no supported inference protocol.", "model")
    }
    const upstream = await this.request(
      protocol === "responses" ? "responses" : "chat/completions", upstreamPayload, signal, context,
    )
    if (!context) await this.logger?.write({
      event: "upstream", route: "/codex/v1/responses", protocol,
      source: "upstream", status: upstream.status,
      requestBytes: Buffer.byteLength(JSON.stringify(upstreamPayload)),
      requestId: upstream.headers.get("x-request-id") ?? upstream.headers.get("x-github-request-id") ?? undefined,
    })
    return protocol === "responses" ? upstream : await fromChatCompletion(upstream, model.id, names)
  }

  private async codexModelsForRouting(signal?: AbortSignal, context?: RequestContext): Promise<CopilotModel[]> {
    if (this.codexModelCache && this.codexModelCache.expiresAt > Date.now()) return this.codexModelCache.models
    const { data } = await this.fetchModels(signal, context)
    this.codexModelCache = { models: data, expiresAt: Date.now() + 60_000 }
    return data
  }

  public async chatCompletion(payload: unknown, signal?: AbortSignal, context?: RequestContext): Promise<Response> {
    return await this.request("chat/completions", payload, signal, context)
  }

  private async request(
    path: "chat/completions" | "responses",
    payload: unknown,
    signal?: AbortSignal,
    context?: RequestContext,
  ): Promise<Response> {
    const body = JSON.stringify(payload)
    const protocol = path === "responses" ? "responses" : "chat-completions"
    return await this.requestWithSession(session => {
      const headers = copilotHeaders(session.token, hasAgentInput(payload))
      const action = () => fetch(`${session.apiBase}/${path}`, {
        method: "POST",
        headers,
        body,
        signal,
      })
      return context ? context.upstream(action, "inference", protocol, Buffer.byteLength(body), headers["x-request-id"]) : action()
    }, signal, context)
  }

  private async fetchModels(signal?: AbortSignal, context?: RequestContext): Promise<ModelsReply> {
    const response = await this.requestWithSession(session => {
      const headers = copilotHeaders(session.token, false)
      const action = () => fetch(`${session.apiBase}/models`, {
        headers,
        signal,
      })
      return context ? context.upstream(action, "models", undefined, undefined, headers["x-request-id"]) : action()
    }, signal, context)
    if (!response.ok) return await passthroughError(response)
    return await response.json() as ModelsReply
  }

  private async requestWithSession(
    request: (
      session: { token: string; expiresAt: number; apiBase: string },
    ) => Promise<Response>,
    signal?: AbortSignal,
    context?: RequestContext,
  ): Promise<Response> {
    signal?.throwIfAborted()
    const session = await this.sessionToken()
    signal?.throwIfAborted()
    let response: Response
    try {
      response = await request(session)
    } catch (error) {
      if (signal?.aborted) throw error
      this.setHealth("upstream-unavailable", "upstream-unavailable", context?.id)
      throw classifyProviderError(error, "upstream-unavailable")
    }
    if (![401, 403].includes(response.status)) {
      this.observeResponse(response, context?.id)
      return response
    }

    await response.body?.cancel()
    if (this.session === session) this.session = undefined
    let retried: Response
    let retrySession: { token: string; expiresAt: number; apiBase: string }
    try {
      retrySession = await this.sessionToken()
      signal?.throwIfAborted()
      retried = await request(retrySession)
    } catch (error) {
      if (signal?.aborted) throw error
      if (this.modelHealth.status !== "reauth-required") {
        this.setHealth("upstream-unavailable", "upstream-unavailable", context?.id)
      }
      if (error instanceof ProviderRequestError) throw error
      throw classifyProviderError(error, "upstream-unavailable")
    }
    if ([401, 403].includes(retried.status)) {
      if (this.session === retrySession) this.session = undefined
      this.setHealth("reauth-required", "copilot-access-rejected", context?.id)
    } else {
      this.observeResponse(retried, context?.id)
    }
    return retried
  }

  private async sessionToken(): Promise<{ token: string; expiresAt: number; apiBase: string }> {
    if (this.session && Date.now() < this.session.expiresAt - 60_000) return this.session
    if (this.pendingSession) return await this.pendingSession
    const pending = this.exchangeSessionToken()
    this.pendingSession = pending
    try {
      return await pending
    } finally {
      if (this.pendingSession === pending) this.pendingSession = undefined
    }
  }

  private async exchangeSessionToken(): Promise<{
    token: string
    expiresAt: number
    apiBase: string
  }> {
    let githubToken: string
    try {
      githubToken = typeof this.githubTokenSource === "string"
        ? this.githubTokenSource
        : await this.githubTokenSource(false)
    } catch (error) {
      throw this.classifyCredentialError(error)
    }
    let reply: SessionTokenReply
    try {
      reply = await this.exchangeWithGitHubToken(githubToken)
    } catch (error) {
      if (
        error instanceof RetryableHttpError
        && error.response.status === 401
        && typeof this.githubTokenSource !== "string"
      ) {
        try {
          const refreshedToken = await this.githubTokenSource(true)
          if (refreshedToken !== githubToken) {
            reply = await this.exchangeWithGitHubToken(refreshedToken)
            return this.acceptSessionToken(reply)
          }
        } catch (refreshError) {
          throw this.classifyCredentialError(refreshError)
        }
      }
      throw this.classifyCredentialError(error)
    }
    return this.acceptSessionToken(reply)
  }

  private async exchangeWithGitHubToken(githubToken: string): Promise<SessionTokenReply> {
    return await retry(async () => {
      let response: Response
      try {
        response = await fetch("https://api.github.com/copilot_internal/v2/token", {
          headers: githubHeaders(githubToken),
        })
      } catch (error) {
        throw new GitHubCredentialUnavailableError(
          "Copilot token exchange request failed",
          { cause: error },
        )
      }
      if (!response.ok) throw new RetryableHttpError(response)
      try {
        return await response.json() as SessionTokenReply
      } catch (error) {
        throw new GitHubCredentialUnavailableError(
          "Copilot token exchange returned an invalid response",
          { cause: error },
        )
      }
    })
  }

  private acceptSessionToken(reply: SessionTokenReply): {
    token: string
    expiresAt: number
    apiBase: string
  } {
    const apiBase = reply.endpoints?.api?.replace(/\/+$/, "")
      ?? "https://api.githubcopilot.com"
    const session = {
      token: reply.token,
      expiresAt: reply.expires_at * 1000,
      apiBase,
    }
    this.session = session
    this.setHealth("ready")
    return session
  }

  private classifyCredentialError(error: unknown): ProviderRequestError {
    const explicitFailureCode = failureCodeFrom(error)
    if (error instanceof ProviderRequestError && explicitFailureCode === undefined) {
      this.setHealth("upstream-unavailable", "upstream-unavailable")
      return error
    }
    const failureCode = explicitFailureCode
      ?? (error instanceof GitHubCredentialUnavailableError
        ? "upstream-unavailable"
        : "github-credential-rejected")
    if (failureCode === "upstream-unavailable") {
      this.setHealth("upstream-unavailable", failureCode)
    } else {
      this.setHealth("reauth-required", failureCode)
    }
    return classifyProviderError(error, failureCode)
  }

  private setHealth(
    status: ModelHealth["status"],
    code?: ModelHealth["code"],
    requestId?: string,
  ): void {
    this.modelHealth = {
      status,
      ...(code === undefined ? {} : { code }),
      observedAt: new Date().toISOString(),
    }
    for (const listener of this.healthListeners) listener(this.modelHealth, requestId)
  }

  private observeResponse(response: Response, requestId?: string): void {
    if (response.status === 429 || response.status >= 500) {
      this.setHealth("upstream-unavailable", "upstream-unavailable", requestId)
    } else {
      this.setHealth("ready", undefined, requestId)
    }
  }
}

function supportsProtocol(model: CopilotModel, protocol: CopilotProtocol): boolean {
  if (model.supported_endpoints === undefined) return protocol === "responses"
  const suffix = protocol === "responses" ? "/responses" : "/chat/completions"
  return model.supported_endpoints.some(endpoint =>
    endpoint === suffix.slice(1) || endpoint.endsWith(suffix))
}

function normalizeReasoningEfforts(efforts: readonly string[]): Record<string, string> {
  return Object.fromEntries(efforts.map(effort => [
    effort === "none" ? "off" : effort,
    effort,
  ]))
}

function preferredReasoningEffort(efforts: readonly string[]): string | null {
  for (const preferred of ["medium", "low", "high", "none"]) {
    if (efforts.includes(preferred)) return preferred
  }
  return efforts[0] ?? null
}

function reasoningEffortDescription(effort: string): string {
  if (effort === "none") return "No additional reasoning"
  return `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)} reasoning`
}

function hasAgentInput(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const input = Array.isArray(payload["input"]) ? payload["input"] : []
  const messages = Array.isArray(payload["messages"]) ? payload["messages"] : []
  return [...input, ...messages].some(item => isRecord(item)
    && (item["role"] === "assistant"
      || item["role"] === "tool"
      || item["type"] === "function_call"
      || item["type"] === "function_call_output"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withExplicitNonStrictTools(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload["tools"])) return payload
  let changed = false
  const tools = payload["tools"].map((tool) => {
    if (isRecord(tool) && tool["type"] === "namespace" && Array.isArray(tool["tools"])) {
      const nested = withExplicitNonStrictTools({ tools: tool["tools"] })
      if (isRecord(nested) && nested["tools"] !== tool["tools"]) {
        changed = true
        return { ...tool, tools: nested["tools"] }
      }
    }
    if (!isRecord(tool) || tool["type"] !== "function" || "strict" in tool) return tool
    changed = true
    return { ...tool, strict: false }
  })
  return changed ? { ...payload, tools } : payload
}

class RetryableHttpError extends ProviderRequestError {
  public constructor(public readonly response: Response) {
    const transient = response.status === 429 || response.status >= 500
    const failureCode: ProviderFailureCode | undefined = response.status === 403
      ? "copilot-access-rejected"
      : response.status === 401
        ? "github-credential-rejected"
        : transient
          ? "upstream-unavailable"
          : undefined
    super(`Copilot token exchange failed (${response.status})`, {
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(transient ? { retryAfter: validRetryAfter(response) } : {}),
    })
  }
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof RetryableHttpError)
        || ![429, 502, 503, 504].includes(error.response.status)
        || attempt === 10) throw error
      await error.response.body?.cancel()
      await Bun.sleep(attempt * 1000)
    }
  }
  throw new Error("unreachable")
}

async function passthroughError(response: Response): Promise<never> {
  const transient = response.status === 429 || response.status >= 500
  const failureCode: ProviderFailureCode | undefined = response.status === 401
    || response.status === 403
    ? "copilot-access-rejected"
    : transient
      ? "upstream-unavailable"
      : undefined
  await response.body?.cancel()
  throw new ProviderRequestError(`Copilot request failed (${response.status})`, {
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(transient ? { retryAfter: validRetryAfter(response) } : {}),
  })
}
