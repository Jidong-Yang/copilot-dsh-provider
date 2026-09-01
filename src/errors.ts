export type ProviderFailureCode =
  | "github-credential-rejected"
  | "copilot-access-rejected"
  | "upstream-unavailable"

export interface ProviderErrorOptions extends ErrorOptions {
  failureCode?: ProviderFailureCode
  retryAfter?: string
}

export class ProviderRequestError extends Error {
  public readonly failureCode?: ProviderFailureCode
  public readonly retryAfter?: string

  public constructor(message: string, options?: ProviderErrorOptions) {
    super(message, options)
    this.failureCode = options?.failureCode
    this.retryAfter = options?.retryAfter
  }
}

export function validRetryAfter(
  response: Response,
  now = new Date(),
): string | undefined {
  const value = response.headers.get("retry-after")?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return value
  return validHttpDate(value, now) ? value : undefined
}

const MONTHS = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
])
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function validHttpDate(value: string, now: Date): boolean {
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  if (imf) return validDate(imf, SHORT_WEEKDAYS, 4, now)

  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  if (rfc850) return validDate(rfc850, LONG_WEEKDAYS, 2, now)

  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: {2}([1-9])| ([12]\d|3[01])) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value)
  if (!asctime) return false
  return dateComponentsAreValid(
    asctime[1]!,
    SHORT_WEEKDAYS,
    Number(asctime[8]),
    asctime[2]!,
    Number(asctime[3] ?? asctime[4]),
    Number(asctime[5]),
    Number(asctime[6]),
    Number(asctime[7]),
  )
}

function validDate(
  match: RegExpExecArray,
  weekdays: string[],
  yearDigits: 2 | 4,
  now: Date,
): boolean {
  const writtenYear = Number(match[4])
  let year = writtenYear
  if (yearDigits === 2) {
    year += Math.floor(now.getUTCFullYear() / 100) * 100
    const candidate = httpDate(
      year,
      match[3]!,
      Number(match[2]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
    )
    const futureLimit = new Date(now)
    futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 50)
    if (candidate.getTime() > futureLimit.getTime()) year -= 100
  }
  return dateComponentsAreValid(
    match[1]!,
    weekdays,
    year,
    match[3]!,
    Number(match[2]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  )
}

function dateComponentsAreValid(
  weekday: string,
  weekdays: string[],
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const month = MONTHS.get(monthName)
  if (
    month === undefined
    || hour > 23
    || minute > 59
    || second > 60
  ) return false
  const date = httpDate(year, monthName, day, hour, minute, second)
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    && weekdays[date.getUTCDay()] === weekday
}

function httpDate(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, MONTHS.get(monthName) ?? 0, day)
  date.setUTCHours(hour, minute, Math.min(second, 59), 0)
  return date
}

export function retryAfterFrom(error: unknown): string | undefined {
  return error instanceof ProviderRequestError ? error.retryAfter : undefined
}

export function failureCodeFrom(error: unknown): ProviderFailureCode | undefined {
  return error instanceof ProviderRequestError ? error.failureCode : undefined
}

export function classifyProviderError(
  error: unknown,
  failureCode: ProviderFailureCode,
): ProviderRequestError {
  if (
    error instanceof ProviderRequestError
    && error.failureCode === failureCode
  ) return error
  return new ProviderRequestError("Provider request failed", {
    cause: error,
    failureCode,
    retryAfter: retryAfterFrom(error),
  })
}
