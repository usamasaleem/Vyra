import { describe, expect, it } from 'vitest'
import {
  addDays, civilDateIn, confirmationQuestion, formatCivil, resolveDatePhrase,
} from '../src/dates.ts'

const DUBAI = 'Asia/Dubai'
/** Sunday 13 September 2026, 14:00 UTC = 18:00 in Dubai. */
const SUNDAY_AFTERNOON = new Date('2026-09-13T14:00:00Z')

const resolve = (phrase: string, at = SUNDAY_AFTERNOON, tz = DUBAI) =>
  resolveDatePhrase(phrase, { messageSentAt: at, timeZone: tz })

describe('reading the operator local date', () => {
  it('uses the operator timezone, not the server', () => {
    const local = civilDateIn(SUNDAY_AFTERNOON, DUBAI)
    expect(formatCivil(local)).toBe('2026-09-13')
    expect(local.hour).toBe(18)
  })

  /** The case section 15 names: near midnight, UTC and Dubai disagree. */
  it('is already tomorrow in Dubai when it is still today in UTC', () => {
    const lateUtc = new Date('2026-09-13T21:30:00Z') // 01:30 on the 14th in Dubai
    expect(formatCivil(civilDateIn(lateUtc, DUBAI))).toBe('2026-09-14')
    expect(formatCivil(civilDateIn(lateUtc, 'UTC'))).toBe('2026-09-13')
  })
})

describe('resolving relative dates', () => {
  it('reads tomorrow against the operator timezone', () => {
    const r = resolve('tomorrow')
    expect(r).toMatchObject({ resolved: true, date: '2026-09-14', needsConfirmation: true })
  })

  /**
   * The failure this whole function exists to prevent: at 21:30 UTC it is
   * already the 14th in Dubai, so "tomorrow" is the 15th, not the 14th.
   */
  it('does not book the wrong day for a message sent near midnight', () => {
    const lateUtc = new Date('2026-09-13T21:30:00Z')
    const dubai = resolve('tomorrow', lateUtc, DUBAI)
    const utc = resolve('tomorrow', lateUtc, 'UTC')

    expect(dubai).toMatchObject({ date: '2026-09-15', crossedMidnight: true })
    expect(utc).toMatchObject({ date: '2026-09-14', crossedMidnight: false })
  })

  it('reads today and tonight as the same day', () => {
    expect(resolve('today')).toMatchObject({ date: '2026-09-13' })
    expect(resolve('tonight')).toMatchObject({ date: '2026-09-13' })
  })

  it('reads a day count', () => {
    expect(resolve('in 3 days')).toMatchObject({ date: '2026-09-16' })
  })

  it('reads a weekday as the next one that has not happened', () => {
    // The 13th is a Sunday, so Friday is the 18th.
    expect(resolve('friday')).toMatchObject({ date: '2026-09-18' })
    expect(resolve('on friday')).toMatchObject({ date: '2026-09-18' })
  })

  it('reads "next friday" as the one after that', () => {
    expect(resolve('next friday')).toMatchObject({ date: '2026-09-25' })
  })

  it('reads a weekday naming today as today', () => {
    expect(resolve('sunday')).toMatchObject({ date: '2026-09-13' })
  })
})

describe('what it refuses to guess', () => {
  /** Section 15: ask for exact dates, store the phrase. */
  it('will not resolve a weekend', () => {
    const r = resolve('this weekend')
    expect(r).toMatchObject({ resolved: false, reason: 'ambiguous', originalWording: 'this weekend' })
    if (!r.resolved) expect(r.clarify).toMatch(/exact dates/)
  })

  it('will not resolve a date in the past', () => {
    expect(resolve('yesterday')).toMatchObject({ resolved: false, reason: 'in_the_past' })
  })

  it('says it does not understand rather than guessing', () => {
    const r = resolve('sometime after the Grand Prix')
    expect(r).toMatchObject({ resolved: false, reason: 'unrecognised' })
    if (!r.resolved) expect(r.clarify).toMatch(/Ask for the date/)
  })
})

describe('confirmation is not optional', () => {
  /**
   * Not a confidence score with a threshold. A threshold gets tuned down; a
   * constant true does not.
   */
  it('marks every resolved date as needing confirmation', () => {
    for (const phrase of ['today', 'tomorrow', 'friday', 'in 3 days', 'next friday']) {
      const r = resolve(phrase)
      expect(r.resolved && r.needsConfirmation, phrase).toBe(true)
    }
  })

  it('spells the date out in the question rather than repeating the phrase', () => {
    const r = resolve('tomorrow')
    if (!r.resolved) throw new Error('expected a resolution')
    const question = confirmationQuestion(r, DUBAI)
    expect(question).toContain('Monday 14 September')
    expect(question).toContain('"tomorrow"')
  })
})

describe('the original wording survives', () => {
  it('keeps what the customer typed, including their casing', () => {
    expect(resolve('Tomorrow')).toMatchObject({ originalWording: 'Tomorrow', date: '2026-09-14' })
    expect(resolve('  this weekend ')).toMatchObject({ originalWording: 'this weekend' })
  })
})

describe('civil date arithmetic', () => {
  it('crosses a month end', () => {
    expect(formatCivil(addDays({ year: 2026, month: 9, day: 30 }, 1))).toBe('2026-10-01')
  })

  it('crosses a year end', () => {
    expect(formatCivil(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(formatCivil(addDays({ year: 2028, month: 2, day: 28 }, 1))).toBe('2028-02-29')
  })
})
