import { describe, expect, it } from 'vitest'
import { isOpenAt, readServiceHours } from '../src/business-hours.ts'

const DUBAI = 'Asia/Dubai'
/** 09:00 to 21:00 Sunday to Thursday, 10:00 to 22:00 Friday and Saturday. */
const weekday = { open: '09:00', close: '21:00' }
const weekend = { open: '10:00', close: '22:00' }
const PILOT = readServiceHours({
  0: weekday, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekend, 6: weekend,
})

/** Dubai is UTC+4 and does not change. */
const dubai = (local: string) => new Date(`${local}+04:00`)

describe('whether somebody is there', () => {
  it('is open in the middle of a working day', () => {
    // Thursday 17 September 2026, 14:00 Dubai.
    expect(isOpenAt(PILOT, dubai('2026-09-17T14:00'), DUBAI)).toBe(true)
  })

  it('is shut at three in the morning', () => {
    expect(isOpenAt(PILOT, dubai('2026-09-17T03:00'), DUBAI)).toBe(false)
  })

  it('opens on the minute and shuts on the minute', () => {
    expect(isOpenAt(PILOT, dubai('2026-09-17T09:00'), DUBAI)).toBe(true)
    expect(isOpenAt(PILOT, dubai('2026-09-17T08:59'), DUBAI)).toBe(false)
    expect(isOpenAt(PILOT, dubai('2026-09-17T20:59'), DUBAI)).toBe(true)
    expect(isOpenAt(PILOT, dubai('2026-09-17T21:00'), DUBAI)).toBe(false)
  })

  /** Friday runs an hour later here, which is the point of per-day hours. */
  it('uses the right day', () => {
    // Friday 18 September 2026.
    expect(isOpenAt(PILOT, dubai('2026-09-18T09:30'), DUBAI)).toBe(false)
    expect(isOpenAt(PILOT, dubai('2026-09-18T21:30'), DUBAI)).toBe(true)
  })

  /**
   * The operator's clock, not the server's. A worker in another region must
   * not decide Dubai is shut because it is three in the morning where it runs.
   */
  it('reads the operator’s timezone rather than the machine’s', () => {
    // 22:00 UTC is 02:00 the next day in Dubai — shut.
    expect(isOpenAt(PILOT, new Date('2026-09-17T22:00:00Z'), DUBAI)).toBe(false)
    // 10:00 UTC is 14:00 in Dubai — open.
    expect(isOpenAt(PILOT, new Date('2026-09-17T10:00:00Z'), DUBAI)).toBe(true)
  })

  it('shuts a day the operator marked closed', () => {
    // Thursday is day 4; the column's rule is that an absent day is shut.
    const hours = readServiceHours({ 0: weekday, 1: weekday, 2: weekday, 3: weekday,
      5: weekend, 6: weekend })
    expect(isOpenAt(hours, dubai('2026-09-17T14:00'), DUBAI)).toBe(false)
  })
})

/**
 * "22:00 to 02:00" is a real shift in this market, and reading it as a
 * zero-length day would shut the business precisely when it is busiest.
 */
describe('a shift that runs past midnight', () => {
  // Thursday 22:00 to 02:00, and nothing on Friday.
  const NIGHTS = readServiceHours({ 4: { open: '22:00', close: '02:00' } })

  it('is open before midnight', () => {
    expect(isOpenAt(NIGHTS, dubai('2026-09-17T23:30'), DUBAI)).toBe(true)
  })

  it('is still open after it', () => {
    // Friday 01:00, which is Thursday's shift still running.
    expect(isOpenAt(NIGHTS, dubai('2026-09-18T01:00'), DUBAI)).toBe(true)
  })

  it('is shut once it ends', () => {
    expect(isOpenAt(NIGHTS, dubai('2026-09-18T02:30'), DUBAI)).toBe(false)
  })
})

/**
 * An operator who has not said when they work is not thereby closed. The
 * out-of-hours message is a claim about somebody else's business.
 */
describe('hours nobody has set', () => {
  it.each([null, undefined, {}, 'nine to five', [], 42])('treats %j as always open', (raw) => {
    expect(isOpenAt(readServiceHours(raw), dubai('2026-09-17T03:00'), DUBAI)).toBe(true)
  })

  /**
   * Once a week is written down, a day left out of it is a day they are shut.
   * That is the rule the column has always documented.
   */
  it('shuts a day left out of a week somebody did write', () => {
    const onlyFriday = readServiceHours({ 5: weekend })
    expect(isOpenAt(onlyFriday, dubai('2026-09-17T14:00'), DUBAI)).toBe(false)
  })
})

describe('reading what was stored', () => {
  it('keeps a well-formed week', () => {
    expect(readServiceHours({ 1: { open: '09:00', close: '17:30' } }))
      .toEqual({ 1: { open: '09:00', close: '17:30' } })
  })

  it('drops a day written as nothing rather than refusing the week', () => {
    expect(readServiceHours({ 1: { open: '09:00', close: '17:30' }, 2: null }))
      .toEqual({ 1: { open: '09:00', close: '17:30' } })
  })

  /** A half-parsed value would close the business on a Tuesday. */
  it.each([
    { 1: { open: '9am', close: '5pm' } },
    { 1: { open: '09:00' } },
    { 1: { open: '25:00', close: '26:00' } },
    { 1: '09:00-17:00' },
    { 1: { open: 9, close: 17 } },
  ])('refuses %j rather than guessing', (raw) => {
    expect(readServiceHours(raw)).toBeNull()
  })

  it('ignores a key that is not a day', () => {
    expect(readServiceHours({ 1: { open: '09:00', close: '17:00' }, monday: 'all day' }))
      .toEqual({ 1: { open: '09:00', close: '17:00' } })
  })
})
