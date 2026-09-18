/**
 * When the operator's people are there.
 *
 * `operators.service_hours` has existed since the schema was written, with a
 * type, a documented shape and a comment saying what it is for — "opening
 * hours, for honest out-of-hours replies rather than invented ones". Nothing
 * has ever read it or written it. This is the code that was missing, not a new
 * column.
 *
 * The `business-hours` knowledge topic is the same fact in prose and stays:
 * that is what a customer is told, and a sentence cannot be compared to a
 * clock. Nothing here is ever sent to anybody.
 *
 * Null means the operator has not said, and an operator who has not said is
 * never treated as closed. Telling a customer the office is shut is a claim
 * about somebody else's business, and guessing it is the mistake this project
 * spent a day undoing.
 */

/** The shape `operators.service_hours` has always declared. 0 is Sunday. */
export type ServiceHours = Record<string, { open: string; close: string } | undefined>

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes since local midnight, or null when it is not a time. */
function minutesOf(value: string): number | null {
  const match = TIME.exec(value)
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Whatever came out of the column, as hours or as nothing.
 *
 * Validated rather than cast. This is edited by hand in a form and read by
 * code that decides whether to tell a customer nobody is in; a half-parsed
 * value would shut the business on a Tuesday. One bad day discards the lot,
 * because a week with a hole in it is not a week anybody meant to write.
 */
export function readServiceHours(raw: unknown): ServiceHours | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const hours: ServiceHours = {}

  for (const [day, value] of Object.entries(source)) {
    if (!/^[0-6]$/.test(day)) continue
    if (value === null || value === undefined) continue
    if (typeof value !== 'object' || Array.isArray(value)) return null
    const { open, close } = value as { open?: unknown; close?: unknown }
    if (typeof open !== 'string' || typeof close !== 'string') return null
    if (minutesOf(open) === null || minutesOf(close) === null) return null
    hours[day] = { open, close }
  }

  return Object.keys(hours).length === 0 ? null : hours
}

/** The operator's own local weekday (0 = Sunday) and minute of the day. */
function localAt(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const day = names.indexOf(get('weekday').slice(0, 3).toLowerCase())
  // Midnight comes back as "24" in some runtimes, which is the same minute.
  const hour = Number(get('hour')) % 24
  return { day, minutes: hour * 60 + Number(get('minute')) }
}

/**
 * Whether somebody is there right now.
 *
 * A close time earlier than the open time spans midnight — "22:00" to "02:00"
 * is a real shift in this market, and reading it as a zero-length day would
 * shut the business precisely when it is busiest.
 *
 * Unknown hours are open. See the file header: an operator who has not told us
 * when they work is not thereby closed.
 */
export function isOpenAt(hours: ServiceHours | null, at: Date, timeZone: string): boolean {
  if (hours === null) return true

  const { day, minutes } = localAt(at, timeZone)
  if (day < 0) return true

  const today = hours[String(day)]
  // The column's own documented rule: an absent day is a day they are shut.
  if (today === undefined) return spillsInto(hours, day, minutes)

  const open = minutesOf(today.open)!
  const close = minutesOf(today.close)!
  if (close > open) return minutes >= open && minutes < close
  if (close === open) return false
  // Spans midnight: open until close tomorrow, or still open from yesterday.
  return minutes >= open || minutes < close
}

/** Yesterday's overnight shift, still running after midnight. */
function spillsInto(hours: ServiceHours, day: number, minutes: number): boolean {
  const yesterday = hours[String((day + 6) % 7)]
  if (yesterday === undefined) return false
  const open = minutesOf(yesterday.open)!
  const close = minutesOf(yesterday.close)!
  return close < open && minutes < close
}
