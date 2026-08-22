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

export class CopilotClient {
  private session?: { token: string; expiresAt: number; apiBase: string }
  private pendingSession?: Promise<{ token: string; expiresAt: number; apiBase: string }>

  public constructor(private readonly githubTokenSource: GitHubTokenSource) {}

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
    const response = await request(session)
    if (![401, 403].includes(response.status)) return response

    await response.body?.cancel()
    if (this.session === session) this.session = undefined
    return await request(await this.sessionToken())
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
    const githubToken = typeof this.githubTokenSource === "string"
      ? this.githubTokenSource
      : await this.githubTokenSource()
    const reply = await retry(async () => {
      const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: githubHeaders(githubToken),
      })
      if (!response.ok) throw new RetryableHttpError(response)
      return await response.json() as SessionTokenReply
    })
    const apiBase = reply.endpoints?.api?.replace(/\/+$/, "")
      ?? "https://api.githubcopilot.com"
    const session = {
      token: reply.token,
      expiresAt: reply.expires_at * 1000,
      apiBase,
    }
    this.session = session
    return session
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
