import { copilotHeaders, githubHeaders } from "./config.ts"
import { GitHubCredentialUnavailableError } from "./auth.ts"

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
  private modelHealth: ModelHealth = {
    status: "checking",
    observedAt: new Date().toISOString(),
  }

  public constructor(private readonly githubTokenSource: GitHubTokenSource) {}

  public async health(signal?: AbortSignal): Promise<ModelHealth> {
    try {
      await this.sessionToken()
      if (this.modelHealth.status === "upstream-unavailable") {
        const response = await this.requestWithSession(session =>
          fetch(`${session.apiBase}/models`, {
            headers: copilotHeaders(session.token, false),
            signal,
          }))
        await response.body?.cancel()
      }
    } catch {
      if (this.modelHealth.status !== "reauth-required") {
        this.setHealth("upstream-unavailable", "upstream-unavailable")
      }
    }
    return this.modelHealth
  }

  public async models(
    protocol: CopilotProtocol = "responses",
    signal?: AbortSignal,
  ): Promise<object> {
    const upstream = await this.fetchModels(signal)
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

  public async codexModels(signal?: AbortSignal): Promise<object> {
    const upstream = await this.fetchModels(signal)
    const models = upstream.data
      .filter(model => model.model_picker_enabled !== false)
      .filter(model => supportsProtocol(model, "responses"))

    return {
      models: models.map((model, index) => {
        const efforts = model.capabilities?.supports?.reasoning_effort ?? []
        const contextWindow = model.capabilities?.limits?.max_context_window_tokens
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
              }),
          experimental_supported_tools: [],
          input_modalities: model.capabilities?.supports?.vision === true
            ? ["text", "image"]
            : ["text"],
        }
      }),
    }
  }

  public async response(payload: unknown, signal?: AbortSignal): Promise<Response> {
    return await this.request("responses", withExplicitNonStrictTools(payload), signal)
  }

  public async chatCompletion(payload: unknown, signal?: AbortSignal): Promise<Response> {
    return await this.request("chat/completions", payload, signal)
  }

  private async request(
    path: "chat/completions" | "responses",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return await this.requestWithSession(session =>
      fetch(`${session.apiBase}/${path}`, {
        method: "POST",
        headers: copilotHeaders(session.token, hasAgentInput(payload)),
        body: JSON.stringify(payload),
        signal,
      }))
  }

  private async fetchModels(signal?: AbortSignal): Promise<ModelsReply> {
    const response = await this.requestWithSession(session =>
      fetch(`${session.apiBase}/models`, {
        headers: copilotHeaders(session.token, false),
        signal,
      }))
    if (!response.ok) return await passthroughError(response)
    return await response.json() as ModelsReply
  }

  private async requestWithSession(
    request: (
      session: { token: string; expiresAt: number; apiBase: string },
    ) => Promise<Response>,
  ): Promise<Response> {
    const session = await this.sessionToken()
    let response: Response
    try {
      response = await request(session)
    } catch (error) {
      this.setHealth("upstream-unavailable", "upstream-unavailable")
      throw error
    }
    if (![401, 403].includes(response.status)) {
      this.observeResponse(response)
      return response
    }

    await response.body?.cancel()
    if (this.session === session) this.session = undefined
    let retried: Response
    let retrySession: { token: string; expiresAt: number; apiBase: string }
    try {
      retrySession = await this.sessionToken()
      retried = await request(retrySession)
    } catch (error) {
      if (this.modelHealth.status !== "reauth-required") {
        this.setHealth("upstream-unavailable", "upstream-unavailable")
      }
      throw error
    }
    if ([401, 403].includes(retried.status)) {
      if (this.session === retrySession) this.session = undefined
      this.setHealth("reauth-required", "copilot-access-rejected")
    } else {
      this.observeResponse(retried)
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
      this.classifyCredentialError(error)
      throw error
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
          this.classifyCredentialError(refreshError)
          throw refreshError
        }
      }
      this.classifyCredentialError(error)
      throw error
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

  private classifyCredentialError(error: unknown): void {
    if (error instanceof GitHubCredentialUnavailableError) {
      this.setHealth("upstream-unavailable", "upstream-unavailable")
    } else if (error instanceof RetryableHttpError && error.response.status === 403) {
      this.setHealth("reauth-required", "copilot-access-rejected")
    } else if (
      error instanceof RetryableHttpError
      && ![401, 403].includes(error.response.status)
    ) {
      this.setHealth("upstream-unavailable", "upstream-unavailable")
    } else {
      this.setHealth("reauth-required", "github-credential-rejected")
    }
  }

  private setHealth(
    status: ModelHealth["status"],
    code?: ModelHealth["code"],
  ): void {
    this.modelHealth = {
      status,
      ...(code === undefined ? {} : { code }),
      observedAt: new Date().toISOString(),
    }
  }

  private observeResponse(response: Response): void {
    if (response.status === 429 || response.status >= 500) {
      this.setHealth("upstream-unavailable", "upstream-unavailable")
    } else {
      this.setHealth("ready")
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
    if (!isRecord(tool) || tool["type"] !== "function" || "strict" in tool) return tool
    changed = true
    return { ...tool, strict: false }
  })
  return changed ? { ...payload, tools } : payload
}

class RetryableHttpError extends Error {
  public constructor(public readonly response: Response) {
    super(`Copilot token exchange failed (${response.status})`)
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
  throw new Error(`Copilot request failed (${response.status}): ${await response.text()}`)
}
