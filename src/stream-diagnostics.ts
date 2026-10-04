export interface StreamSummary {
  textDeltaEvents: number
  textDeltaChars: number
  textDoneEvents: number
  textDoneChars: number
  completedTextParts: number
  completedTextChars: number
  completedToolCalls: number
  completedEvents: number
  failedEvents: number
  incompleteEvents: number
  malformedEvents: number
  inspectionTruncated: boolean
}

const MAX_FRAME_CHARS = 1_000_000

export class StreamInspector {
  public readonly summary: StreamSummary = {
    textDeltaEvents: 0, textDeltaChars: 0, textDoneEvents: 0, textDoneChars: 0,
    completedTextParts: 0, completedTextChars: 0, completedToolCalls: 0,
    completedEvents: 0, failedEvents: 0, incompleteEvents: 0,
    malformedEvents: 0, inspectionTruncated: false,
  }
  private readonly decoder = new TextDecoder()
  private buffer = ""
  private chatFinish?: "completed" | "incomplete"
  private chatDone = false

  public constructor(private readonly protocol: "responses" | "chat-completions") {}

  public push(chunk: Uint8Array): void {
    if (this.summary.inspectionTruncated) return
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.frames()
  }

  public end(): void {
    if (this.summary.inspectionTruncated) return
    this.buffer += this.decoder.decode()
    this.frames()
    if (this.buffer.trim()) this.inspect(this.buffer)
    this.buffer = ""
  }

  private frames(): void {
    let boundary: RegExpExecArray | null
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer)) !== null) {
      if (boundary.index > MAX_FRAME_CHARS) { this.truncate(); return }
      this.inspect(this.buffer.slice(0, boundary.index))
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
    }
    if (this.buffer.length > MAX_FRAME_CHARS) this.truncate()
  }

  private truncate(): void {
    this.summary.inspectionTruncated = true
    this.buffer = ""
  }

  private inspect(frame: string): void {
    const lines = frame.split(/\r\n|\r|\n/)
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim()
    const data = lines.filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n")
    if (!data) return
    if (data === "[DONE]") {
      if (this.protocol === "chat-completions" && !this.chatDone && this.chatFinish) {
        this.chatDone = true
        if (this.chatFinish === "completed") this.summary.completedEvents++
        else this.summary.incompleteEvents++
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      this.summary.malformedEvents++
      return
    }
    if (!isRecord(parsed)) { this.summary.malformedEvents++; return }
    const type = event || parsed["type"]
    if (type === "error" || parsed["error"] != null) { this.summary.failedEvents++; return }
    if (this.protocol === "chat-completions") {
      if (!Array.isArray(parsed["choices"])) { this.summary.malformedEvents++; return }
      for (const choice of parsed["choices"]) {
        if (!isRecord(choice) || choice["index"] !== 0) continue
        const delta = choice["delta"]
        if (isRecord(delta) && typeof delta["content"] === "string") {
          this.summary.textDeltaEvents++
          this.summary.textDeltaChars += delta["content"].length
        }
        const reason = choice["finish_reason"]
        if (reason === "stop" || reason === "tool_calls") this.chatFinish = "completed"
        else if (reason === "length" || reason === "content_filter") this.chatFinish = "incomplete"
        else if (reason != null) this.summary.malformedEvents++
      }
      return
    }
    if (type === "response.output_text.delta" && typeof parsed["delta"] === "string") {
      this.summary.textDeltaEvents++
      this.summary.textDeltaChars += parsed["delta"].length
    } else if (type === "response.output_text.done" && typeof parsed["text"] === "string") {
      this.summary.textDoneEvents++
      this.summary.textDoneChars += parsed["text"].length
    } else if (type === "response.failed") {
      this.summary.failedEvents++
    } else if (type === "response.incomplete") {
      this.summary.incompleteEvents++
    } else if (type === "response.completed") {
      const response = parsed["response"]
      if (!isRecord(response)) { this.summary.malformedEvents++; return }
      if (response["status"] === "failed") { this.summary.failedEvents++; return }
      if (response["status"] === "incomplete") { this.summary.incompleteEvents++; return }
      this.summary.completedEvents++
      if (!Array.isArray(response["output"])) return
      for (const item of response["output"]) {
        if (!isRecord(item)) continue
        if (item["type"] === "function_call") this.summary.completedToolCalls++
        if (item["type"] !== "message" || !Array.isArray(item["content"])) continue
        for (const part of item["content"]) {
          if (!isRecord(part) || part["type"] !== "output_text" || typeof part["text"] !== "string") continue
          this.summary.completedTextParts++
          this.summary.completedTextChars += part["text"].length
        }
      }
    }
  }
}

export function observeResponsesStream(
  body: ReadableStream<Uint8Array>,
  onComplete: (summary: StreamSummary) => Promise<void>,
): ReadableStream<Uint8Array> {
  const inspector = new StreamInspector("responses")
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspector.push(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      inspector.end()
      await onComplete(inspector.summary)
    },
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
