import { expect, test } from "bun:test"

import { observeResponsesStream } from "../src/stream-diagnostics.ts"
import type { StreamSummary } from "../src/stream-diagnostics.ts"

test("preserves SSE bytes across chunks while counting text and terminal events", async () => {
  const source = [
    'event: response.output_text.delta\ndata: {"delta":"O',
    'K"}\n\n',
    'event: response.output_text.done\r\ndata: {"text":"OK"}\r\n\r\n',
    'event: response.completed\ndata: {"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]},{"type":"function_call","name":"x"}]}}\n\n',
    'data: [DONE]\n\n',
  ]
  const chunks = source.map(part => new TextEncoder().encode(part))
  const summaries: StreamSummary[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const observed = observeResponsesStream(stream, summary => {
    summaries.push(summary)
    return Promise.resolve()
  })

  expect(await new Response(observed).text()).toBe(source.join(""))
  expect(summaries).toEqual([{
    textDeltaEvents: 1, textDeltaChars: 2,
    textDoneEvents: 1, textDoneChars: 2,
    completedTextParts: 1, completedTextChars: 2,
    completedToolCalls: 1, completedEvents: 1,
    failedEvents: 0, incompleteEvents: 0, malformedEvents: 0, inspectionTruncated: false,
  }])
})

test("counts repeated text events without collecting text", async () => {
  const body = [
    'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n',
    'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n',
    'event: response.output_text.done\ndata: {"text":"OKOK"}\n\n',
    'event: response.failed\ndata: {"response":{"error":{"message":"private"}}}\n\n',
  ].join("")
  let summary: StreamSummary | undefined
  const stream = observeResponsesStream(new Response(body).body!, result => {
    summary = result
    return Promise.resolve()
  })
  expect(await new Response(stream).text()).toBe(body)
  expect(summary).toMatchObject({
    textDeltaEvents: 2, textDeltaChars: 4, textDoneEvents: 1,
    textDoneChars: 4, failedEvents: 1,
  })
  expect(JSON.stringify(summary)).not.toContain("OK")
  expect(JSON.stringify(summary)).not.toContain("private")
})
