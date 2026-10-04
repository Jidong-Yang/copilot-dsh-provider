import type { LogEntry, RequestLogger } from "./log.ts"
import { StreamInspector } from "./stream-diagnostics.ts"
import type { StreamSummary } from "./stream-diagnostics.ts"

export type RequestOutcome = "success" | "failure" | "rejected" | "cancelled" | "incomplete" | "unverified"
type ServiceStatus = "unknown" | "healthy" | "degraded"
type DependencyHealth = { status: string; code?: string; observedAt?: string }

const WINDOW_MS = 5 * 60_000
const MAX_SAMPLES = 1_000

interface Sample {
  endedAt: number
  durationMs: number
  headersMs?: number
  firstByteMs?: number
  outcome: RequestOutcome
}

function counts() {
  return { success: 0, failure: 0, rejected: 0, cancelled: 0, incomplete: 0, unverified: 0 }
}

function latency(values: number[]) {
  values.sort((a, b) => a - b)
  const percentile = (p: number) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)]! : null
  return { samples: values.length, p50: percentile(0.5), p95: percentile(0.95), max: values.at(-1) ?? null }
}

export class Instrumentation {
  private readonly startedAt: number
  private started = 0
  private completed = 0
  private active = 0
  private logFailures = 0
  private loggingFailed = false
  private readonly totals = counts()
  private samples: Sample[] = []
  private serviceStatus: ServiceStatus = "unknown"
  private observedAt: number
  private dependency?: DependencyHealth

  public constructor(
    private readonly logger?: RequestLogger,
    private readonly clock: () => number = () => performance.timeOrigin + performance.now(),
  ) {
    this.startedAt = this.observedAt = clock()
  }

  public now(): number { return this.clock() }

  public async write(entry: LogEntry): Promise<void> {
    if (!this.logger) return
    try {
      await this.logger.write(entry)
      this.loggingFailed = false
    } catch {
      this.logFailures++
      this.loggingFailed = true
      console.error("Provider instrumentation log write failed; inspect local log storage permissions and capacity.")
    }
  }

  public observeDependency(health: object, requestId?: string): void {
    if (!("status" in health) || typeof health.status !== "string") return
    const next: DependencyHealth = {
      status: health.status,
      ...("code" in health && typeof health.code === "string" ? { code: health.code } : {}),
      ...("observedAt" in health && typeof health.observedAt === "string" ? { observedAt: health.observedAt } : {}),
    }
    const changed = next.status !== this.dependency?.status || next.code !== this.dependency?.code
    const previous = this.dependency?.status
    this.dependency = next
    if (changed) void this.write({
      event: "health", scope: "dependency", healthStatus: next.status,
      previousHealthStatus: previous, category: next.code, requestId,
    })
  }

  public async begin(request: Request, route: string): Promise<RequestContext> {
    this.started++
    this.active++
    const context = new RequestContext(this, request, route)
    await this.write({ event: "request_started", requestId: context.id, route, method: request.method })
    context.listenForAbort()
    return context
  }

  public async complete(sample: Sample, entry: LogEntry): Promise<void> {
    this.active--
    this.completed++
    this.totals[sample.outcome]++
    this.samples.push(sample)
    this.prune()
    const next = sample.outcome === "failure" ? "degraded"
      : sample.outcome === "success" || sample.outcome === "incomplete" ? "healthy"
      : this.serviceStatus
    const previous = this.serviceStatus
    if (sample.outcome === "success" || sample.outcome === "failure" || sample.outcome === "incomplete") {
      this.observedAt = this.now()
    }
    if (next !== previous) {
      this.serviceStatus = next
      await this.write({ event: "health", scope: "service", healthStatus: next,
        previousHealthStatus: previous, requestId: entry.requestId, category: entry.category })
    }
    await this.write(entry)
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS
    this.samples = this.samples.filter(sample => sample.endedAt > cutoff).slice(-MAX_SAMPLES)
  }

  public snapshot() {
    this.prune()
    const recent = counts()
    for (const sample of this.samples) recent[sample.outcome]++
    const evaluated = recent.success + recent.failure + recent.incomplete
    const serviceStatus = this.loggingFailed ? "degraded" : this.serviceStatus
    const dependencyStatus = this.dependency?.status
    const status = dependencyStatus === "reauth-required" || dependencyStatus === "upstream-unavailable"
      ? "unavailable"
      : serviceStatus === "degraded" ? "degraded"
      : dependencyStatus === "ready" ? "ready" : "unknown"
    return {
      schemaVersion: 1,
      status,
      processId: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      inFlight: this.active,
      service: {
        status: serviceStatus,
        observedAt: new Date(this.observedAt).toISOString(),
        stale: this.now() - this.observedAt >= WINDOW_MS,
        ...(this.loggingFailed ? { code: "instrumentation_log_failure" } : {}),
      },
      dependency: this.dependency ?? { status: "unknown" },
      logging: { enabled: this.logger !== undefined, failures: this.logFailures },
      totals: { started: this.started, completed: this.completed, ...this.totals },
      window: {
        durationMs: WINDOW_MS, maxSamples: MAX_SAMPLES, samples: this.samples.length,
        ...recent,
        failureRate: evaluated ? recent.failure / evaluated : null,
        latencyMs: latency(this.samples.map(sample => sample.durationMs)),
        headersMs: latency(this.samples.flatMap(sample => sample.headersMs === undefined ? [] : [sample.headersMs])),
        firstByteMs: latency(this.samples.flatMap(sample => sample.firstByteMs === undefined ? [] : [sample.firstByteMs])),
      },
    }
  }
}

export class RequestContext {
  public readonly id = crypto.randomUUID()
  private readonly startedAt: number
  private ended = false
  private status?: number
  private headersMs?: number
  private firstByteMs?: number
  private responseBytes = 0
  private requestBytes?: number
  private source: "provider" | "upstream" = "provider"
  private category?: string
  private forcedOutcome?: RequestOutcome
  private upstreamAttempts = 0
  private readonly attempts = { inference: 0, models: 0 }
  private streamSummary?: StreamSummary
  private abortBody?: () => Promise<void>
  private readonly abort = () => {
    const timeout = this.request.signal.reason instanceof DOMException && this.request.signal.reason.name === "TimeoutError"
    void this.finish(timeout ? "failure" : "cancelled", timeout ? "request_timeout" : "client_cancelled", this.streamSummary)
    void this.abortBody?.()
  }

  public constructor(
    private readonly owner: Instrumentation,
    private readonly request: Request,
    public readonly route: string,
  ) {
    this.startedAt = owner.now()
  }

  public listenForAbort(): void {
    this.request.signal.addEventListener("abort", this.abort, { once: true })
    if (this.request.signal.aborted) this.abort()
  }

  public setRequestBytes(bytes: number): void { this.requestBytes = bytes }
  public setSource(source: "provider" | "upstream"): void { this.source = source }
  public setFailure(category: string, outcome?: RequestOutcome): void {
    this.category ??= category
    this.forcedOutcome ??= outcome
  }

  public async upstream(
    action: () => Promise<Response>,
    stage: "inference" | "models",
    protocol?: "responses" | "chat-completions",
    requestBytes?: number,
    upstreamClientRequestId?: string,
  ): Promise<Response> {
    this.upstreamAttempts++
    const attempt = ++this.attempts[stage]
    const started = this.owner.now()
    const entry = { event: "upstream" as const, requestId: this.id, route: this.route, stage, protocol,
      requestBytes, attempt, upstreamClientRequestId }
    let response: Response
    try {
      response = await action()
    } catch (error) {
      await this.owner.write({ ...entry, source: "upstream", durationMs: Math.max(0, this.owner.now() - started),
        category: this.request.signal.aborted ? "client_cancelled" : "upstream_transport_error" })
      throw error
    }
    await this.owner.write({ ...entry, source: "upstream", status: response.status,
      durationMs: Math.max(0, this.owner.now() - started),
      upstreamRequestId: response.headers.get("x-request-id") ?? response.headers.get("x-github-request-id") ?? undefined })
    return response
  }

  private async finish(outcome: RequestOutcome, category?: string, stream?: StreamSummary): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.request.signal.removeEventListener("abort", this.abort)
    const endedAt = this.owner.now()
    const durationMs = Math.max(0, endedAt - this.startedAt)
    await this.owner.complete({ endedAt, durationMs, headersMs: this.headersMs, firstByteMs: this.firstByteMs, outcome }, {
      event: "request_completed", requestId: this.id, route: this.route, method: this.request.method,
      status: this.status, source: this.source, outcome, category: category ?? this.category,
      durationMs, headersMs: this.headersMs, firstByteMs: this.firstByteMs,
      requestBytes: this.requestBytes, responseBytes: this.responseBytes, upstreamAttempts: this.upstreamAttempts, stream,
    })
  }

  private outcome(stream?: StreamSummary): { outcome: RequestOutcome; category?: string } {
    if (this.forcedOutcome) return { outcome: this.forcedOutcome, category: this.category }
    if (this.status !== undefined && (this.status >= 500 || [401, 403, 429].includes(this.status))) {
      return { outcome: "failure", category: this.category ?? "http_error" }
    }
    if (this.status !== undefined && this.status >= 400) return { outcome: "rejected", category: this.category ?? "http_rejected" }
    if (stream) {
      if (stream.failedEvents) return { outcome: "failure", category: "stream_failed" }
      if (stream.inspectionTruncated) return { outcome: "unverified", category: "stream_inspection_limit" }
      if (stream.malformedEvents) return { outcome: "failure", category: "stream_parse_error" }
      if (stream.completedEvents + stream.incompleteEvents > 1) return { outcome: "failure", category: "stream_terminal_conflict" }
      if (stream.incompleteEvents) return { outcome: "incomplete", category: "stream_incomplete" }
      if (!stream.completedEvents) return { outcome: "failure", category: "stream_truncated" }
    }
    return { outcome: "success" }
  }

  public async response(response: Response, protocol?: "responses" | "chat-completions"): Promise<Response> {
    this.status = response.status
    this.headersMs = Math.max(0, this.owner.now() - this.startedAt)
    const headers = new Headers(response.headers)
    headers.set("x-provider-request-id", this.id)
    headers.set("x-provider-error-source", response.ok ? "none" : this.source)
    await this.owner.write({ event: "response_headers", requestId: this.id, route: this.route,
      status: response.status, source: this.source, headersMs: this.headersMs })
    if (this.ended) {
      try { await response.body?.cancel() }
      catch { await this.owner.write({ event: "failure", requestId: this.id, route: this.route, category: "upstream_cancel_failed" }) }
      return new Response(null, { status: response.status, statusText: response.statusText, headers })
    }
    if (!response.body) {
      const outcome = this.outcome()
      if (response.ok && protocol && !this.forcedOutcome) {
        outcome.outcome = "unverified"
        outcome.category = "empty_inference_response"
      }
      await this.finish(outcome.outcome, outcome.category)
      return new Response(null, { status: response.status, statusText: response.statusText, headers })
    }
    const isSSE = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    const inspector = isSSE ? new StreamInspector(protocol ?? "responses") : undefined
    this.streamSummary = inspector?.summary
    const isJSON = response.ok && protocol !== undefined
      && response.headers.get("content-type")?.toLowerCase().includes("application/json")
    const jsonDecoder = isJSON ? new TextDecoder() : undefined
    let json = ""
    let jsonTruncated = false
    const reader = response.body.getReader()
    let stopped = false
    let released = false
    const release = () => {
      if (!released) { released = true; reader.releaseLock() }
    }
    const cancel = async (reason?: unknown) => {
      stopped = true
      try { await reader.cancel(reason) }
      catch { await this.owner.write({ event: "failure", requestId: this.id, route: this.route, category: "upstream_cancel_failed" }) }
      finally { release() }
    }
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        this.abortBody = async () => {
          if (stopped) return
          controller.error(new DOMException("Request aborted.", "AbortError"))
          await cancel(this.request.signal.reason)
        }
        if (this.request.signal.aborted) this.abort()
      },
      pull: async controller => {
        try {
          const { done, value } = await reader.read()
          if (stopped) return
          if (done) {
            stopped = true
            inspector?.end()
            const summary = inspector?.summary
            const result = this.outcome(summary)
            if (response.ok && protocol && !inspector && !jsonDecoder && !this.forcedOutcome) {
              result.outcome = "unverified"
              result.category = "response_protocol_unverified"
            }
            if (jsonDecoder && !this.forcedOutcome) {
              if (jsonTruncated) {
                result.outcome = "unverified"
                result.category = "json_inspection_limit"
              } else {
                json += jsonDecoder.decode()
                try {
                  const value: unknown = JSON.parse(json)
                  result.outcome = "unverified"
                  result.category = "response_not_terminal"
                  if (typeof value === "object" && value !== null) {
                    if ("error" in value && value.error != null || "status" in value && value.status === "failed") {
                      result.outcome = "failure"
                      result.category = "response_failed"
                    } else if ("status" in value && value.status === "incomplete") {
                      result.outcome = "incomplete"
                      result.category = "response_incomplete"
                    } else if (protocol === "responses" && "status" in value && value.status === "completed") {
                      result.outcome = "success"
                      result.category = undefined
                    } else if (protocol === "chat-completions" && "choices" in value && Array.isArray(value.choices)) {
                      const reasons: unknown[] = value.choices.map((choice: unknown) => typeof choice === "object" && choice !== null
                        && "finish_reason" in choice ? choice.finish_reason : undefined)
                      if (reasons.length > 0 && reasons.every(reason => typeof reason === "string"
                        && ["stop", "tool_calls", "length", "content_filter"].includes(reason))) {
                        const incomplete = reasons.some(reason => reason === "length" || reason === "content_filter")
                        result.outcome = incomplete ? "incomplete" : "success"
                        result.category = incomplete ? "response_incomplete" : undefined
                      }
                    }
                  }
                } catch (error) {
                  if (!(error instanceof SyntaxError)) throw error
                  result.outcome = "failure"
                  result.category = "response_json_error"
                }
              }
              json = ""
            }
            await this.finish(result.outcome, result.category, summary)
            release()
            controller.close()
          } else {
            this.responseBytes += value.byteLength
            if (value.byteLength > 0) this.firstByteMs ??= Math.max(0, this.owner.now() - this.startedAt)
            inspector?.push(value)
            if (jsonDecoder && !jsonTruncated) {
              if (this.responseBytes > 1_000_000) {
                jsonTruncated = true
                json = ""
              } else {
                json += jsonDecoder.decode(value, { stream: true })
              }
            }
            controller.enqueue(value)
          }
        } catch (error) {
          if (stopped) return
          stopped = true
          await this.finish("failure", "response_body_error", inspector?.summary)
          release()
          controller.error(error)
        }
      },
      cancel: async reason => {
        stopped = true
        const cancellation = cancel(reason)
        await this.finish("cancelled", "client_cancelled", inspector?.summary)
        await cancellation
      },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }
}
