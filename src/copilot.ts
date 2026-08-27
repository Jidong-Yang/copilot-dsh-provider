import { copilotHeaders, githubHeaders } from "./config.ts"

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

type GitHubTokenSource = string | (() => Promise<string>)

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

  public async models(signal?: AbortSignal): Promise<object> {
    const response = await this.requestWithSession(session =>
      fetch(`${session.apiBase}/models`, {
        headers: copilotHeaders(session.token, false),
        signal,
      }))
    if (!response.ok) return await passthroughError(response)
    const upstream = await response.json() as ModelsReply
    return {
      object: "list",
      data: upstream.data
        .filter(model => model.model_picker_enabled !== false)
        .filter(supportsResponses)
        .map(model => {
          const limits = model.capabilities?.limits
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
          }
        }),
      has_more: false,
    }
  }

  public async response(payload: unknown, signal?: AbortSignal): Promise<Response> {
    return await this.requestWithSession(session =>
      fetch(`${session.apiBase}/responses`, {
        method: "POST",
        headers: copilotHeaders(session.token, hasAgentInput(payload)),
        body: JSON.stringify(withExplicitNonStrictTools(payload)),
        signal,
      }))
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
        : await this.githubTokenSource()
    } catch (error) {
      this.setHealth("reauth-required", "github-credential-rejected")
      throw error
    }
    let reply: SessionTokenReply
    try {
      reply = await retry(async () => {
        const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
          headers: githubHeaders(githubToken),
        })
        if (!response.ok) throw new RetryableHttpError(response)
        return await response.json() as SessionTokenReply
      })
    } catch (error) {
      if (error instanceof RetryableHttpError && [401, 403].includes(error.response.status)) {
        this.setHealth(
          "reauth-required",
          error.response.status === 401
            ? "github-credential-rejected"
            : "copilot-access-rejected",
        )
      } else {
        this.setHealth("upstream-unavailable", "upstream-unavailable")
      }
      throw error
    }
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

function supportsResponses(model: CopilotModel): boolean {
  if (model.supported_endpoints === undefined) return true
  return model.supported_endpoints.some(endpoint =>
    endpoint === "responses" || endpoint.endsWith("/responses"))
}

function hasAgentInput(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload["input"])) return false
  return payload["input"].some(item => isRecord(item)
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
