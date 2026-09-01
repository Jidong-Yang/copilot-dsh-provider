import { expect, test } from "bun:test"

import { validRetryAfter } from "../src/errors.ts"

test.each([
  "0",
  "23",
  "Sun, 06 Nov 1994 08:49:37 GMT",
  "Sunday, 06-Nov-94 08:49:37 GMT",
  "Sun Nov  6 08:49:37 1994",
  "Sun, 06 Nov 1994 08:49:60 GMT",
])("accepts a valid Retry-After value: %s", (value) => {
  expect(validRetryAfter(new Response(null, {
    headers: { "retry-after": value },
  }))).toBe(value)
})

test.each([
  "",
  "1.5",
  "2026-09-01",
  "September 1, 2026",
  "Sun, 06 Nov 1994 08:49:37 PST",
  "Sun, 99 Nov 1994 08:49:37 GMT",
  "Sun, 31 Feb 2026 08:49:37 GMT",
  "Sat, 01 Mar 2026 08:49:37 GMT",
  "Sun Nov 6 08:49:37 1994",
])("rejects an invalid Retry-After value: %s", (value) => {
  expect(validRetryAfter(new Response(null, {
    headers: { "retry-after": value },
  }))).toBeUndefined()
})

test("applies the RFC 850 fifty-year rollover to the complete timestamp", () => {
  const now = new Date("2026-09-01T00:00:00Z")
  expect(validRetryAfter(new Response(null, {
    headers: { "retry-after": "Friday, 31-Dec-76 08:49:37 GMT" },
  }), now)).toBe("Friday, 31-Dec-76 08:49:37 GMT")
  expect(validRetryAfter(new Response(null, {
    headers: { "retry-after": "Thursday, 31-Dec-76 08:49:37 GMT" },
  }), now)).toBeUndefined()
})
