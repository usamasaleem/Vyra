/**
 * Build plan step 22 — resolving what a customer meant by "tomorrow".
 *
 * Two rules from the specification shape everything here.
 *
 * Section 18.4 step 5: resolve relative dates against the operator's timezone
 * using the time the message was sent. Not the server's clock, not UTC. A
 * message arriving at 22:10 UTC is already tomorrow in Dubai, and answering
 * from the server's idea of today books the wrong day.
 *
 * MVP section 3: confirm the calendar date with the customer before it is
 * used, and keep their original wording alongside. So nothing here returns a
 * date to act on — it returns a date to *confirm*, with the phrasing to
 * confirm it. The resolution is a reading, and the customer is the authority.
 */

/** A calendar date in the operator's timezone. Deliberately not an instant. */
export type CivilDate = { year: number; month: number; day: number }

export type DateResolution =
  | {
      resolved: true
      /** ISO calendar date, YYYY-MM-DD, in the operator's timezone. */
      date: string
      /** What the customer typed. Kept because the reading might be wrong. */
      originalWording: string
      /** How this was read, for the confirmation question. */
      interpretation: string
      /**
       * Always true. Section 15 requires confirming an ambiguous date, and
       * every relative phrase is ambiguous until the customer agrees — which
       * is why this is not a confidence score with a threshold somebody will
       * eventually tune to zero.
       */
      needsConfirmation: true
      /** True when the operator-local date differs from the UTC date. */
      crossedMidnight: boolean
    }
  | {
      resolved: false
      originalWording: string
      reason: 'ambiguous' | 'unrecognised' | 'in_the_past'
      /** What to ask the customer instead of guessing. */
      clarify: string
    }

const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** The civil date and hour in a timezone at a given instant. */
export function civilDateIn(at: Date, timeZone: string): CivilDate & { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'long',
  }).formatToParts(at)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    weekday: WEEKDAYS.indexOf(get('weekday').toLowerCase()),
  }
}

export function formatCivil(date: CivilDate): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`
}

/** Adds days to a civil date without going near timezones. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS)
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

/**
 * Reads a relative date phrase.
 *
 * "This weekend" is deliberately NOT resolved. Section 15 says to ask for exact
 * dates and store the original phrase, and for a rental it genuinely matters
 * whether the customer means Friday evening or Saturday morning — guessing
 * would book a day they did not ask for.
 */
export function resolveDatePhrase(
  phrase: string,
  options: { messageSentAt: Date; timeZone: string },
): DateResolution {
  const original = phrase.trim()
  const text = original.toLowerCase().replace(/[.,!?]/g, '').trim()
  const local = civilDateIn(options.messageSentAt, options.timeZone)
  const today: CivilDate = { year: local.year, month: local.month, day: local.day }

  const utcDate = `${options.messageSentAt.getUTCFullYear()}-${String(options.messageSentAt.getUTCMonth() + 1).padStart(2, '0')}-${String(options.messageSentAt.getUTCDate()).padStart(2, '0')}`
  const crossedMidnight = formatCivil(today) !== utcDate

  const resolve = (date: CivilDate, interpretation: string): DateResolution => ({
    resolved: true,
    date: formatCivil(date),
    originalWording: original,
    interpretation,
    needsConfirmation: true,
    crossedMidnight,
  })

  if (/^(today|tonight|this evening|right now|now|asap|urgent)$/.test(text)) {
    return resolve(today, 'today in the operator timezone')
  }
  if (/^(tomorrow|tmrw|tmr)$/.test(text)) {
    return resolve(addDays(today, 1), 'the day after the message was sent')
  }
  if (/^(day after tomorrow|the day after tomorrow)$/.test(text)) {
    return resolve(addDays(today, 2), 'two days after the message was sent')
  }

  const inDays = text.match(/^in (\d+) days?$/)
  if (inDays !== null) {
    return resolve(addDays(today, Number(inDays[1])), `${inDays[1]} days after the message`)
  }

  /**
   * Weekday names. "Friday" means the next Friday that has not happened —
   * and if today is Friday, a customer saying "Friday" almost always means
   * today, so that is what it reads as and the confirmation catches it.
   */
  const weekday = text.match(/^(?:this |next |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/)
  if (weekday !== null) {
    const target = WEEKDAYS.indexOf(weekday[1]!)
    let delta = (target - local.weekday + 7) % 7
    if (text.startsWith('next ') && delta === 0) delta = 7
    if (text.startsWith('next ') && delta < 7) delta += 7
    return resolve(
      addDays(today, delta),
      delta === 0 ? 'today, which is that weekday' : `the coming ${weekday[1]}`,
    )
  }

  if (/weekend/.test(text)) {
    return {
      resolved: false,
      originalWording: original,
      reason: 'ambiguous',
      clarify:
        'Ask which exact dates they mean. A weekend can start Friday evening or Saturday morning, and the difference is a day of rental.',
    }
  }

  if (/^(yesterday|last \w+)$/.test(text)) {
    return {
      resolved: false,
      originalWording: original,
      reason: 'in_the_past',
      clarify: 'That date has passed. Ask which upcoming date they mean.',
    }
  }

  return {
    resolved: false,
    originalWording: original,
    reason: 'unrecognised',
    clarify: 'Ask for the date directly, for example "the 20th" or "next Tuesday".',
  }
}

/**
 * The sentence to confirm a reading with.
 *
 * Phrased as a question with the date spelled out, because "confirmed" means
 * the customer agreed to a specific calendar day — not that they failed to
 * object to the word "tomorrow".
 */
export function confirmationQuestion(
  resolution: Extract<DateResolution, { resolved: true }>,
  timeZone: string,
): string {
  const [year, month, day] = resolution.date.split('-').map(Number)
  const spelled = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(Date.UTC(year!, month! - 1, day!)))
  return `Just to confirm — by "${resolution.originalWording}" you mean ${spelled}?`
}
