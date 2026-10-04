export const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024

export class CodexRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly param?: string,
    public readonly requestBytes?: number,
  ) {
    super(message)
  }
}

export async function readCodexRequest(
  request: Request,
  limit = MAX_REQUEST_BODY_BYTES,
): Promise<{ payload: unknown; requestBytes: number }> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase()
  if (encoding && encoding !== "identity" && encoding !== "gzip" && encoding !== "deflate" && encoding !== "zstd") {
    throw new CodexRequestError(415, "unsupported_content_encoding",
      "Unsupported request compression. Send identity, gzip, deflate, or zstd encoding.")
  }
  const length = request.headers.get("content-length")
  if (length !== null && Number(length) > limit) throw bodyTooLarge(Number(length))
  let body = request.body
  if (!body) throw invalidJson()
  if (encoding === "gzip" || encoding === "deflate" || encoding === "zstd") {
    body = body.pipeThrough(new DecompressionStream(encoding))
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let requestBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      requestBytes += value.byteLength
      if (requestBytes > limit) {
        await reader.cancel()
        throw bodyTooLarge(requestBytes)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof CodexRequestError || request.signal.aborted) throw error
    throw new CodexRequestError(400, "invalid_request_body", "Request body could not be decoded.")
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(requestBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), requestBytes }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error
    throw invalidJson()
  }
}

function invalidJson(): CodexRequestError {
  return new CodexRequestError(400, "invalid_json", "Request body must be valid UTF-8 JSON.")
}

function bodyTooLarge(requestBytes: number): CodexRequestError {
  return new CodexRequestError(413, "request_body_too_large",
    "Provider request body exceeds 128 MiB. Compact the Codex conversation or reduce attachments before retrying.",
    undefined, requestBytes)
}
