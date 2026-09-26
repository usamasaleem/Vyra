import { describe, expect, it } from 'vitest'
import { AUTOMATED_MESSAGES, AUTOMATED_MESSAGE_LABELS, readyStarter } from '../src/automated-messages.ts'
import { SERVICE_HOURS_PATTERNS, isOpenAt, readServiceHours } from '../src/business-hours.ts'
import { hasUnfilledBlank } from '../src/policy-topics.ts'

describe('starters an operator can accept in one tap', () => {
  /** The card's finish line: every automated message has one. */
  it('exists for every automated message, with no blank left in it', () => {
    for (const topic of AUTOMATED_MESSAGES) {
      const ready = readyStarter(topic, 'Prestige Cars')
      expect(ready, topic).not.toBeNull()
      expect(hasUnfilledBlank(ready!), topic).toBe(false)
    }
  })

  it('names the business it is written for', () => {
    expect(readyStarter('greeting', 'Prestige Cars')).toContain('Prestige Cars')
    expect(readyStarter('thank-you', 'Prestige Cars')).toContain('Prestige Cars')
  })

  it('is the starter itself whenever the starter has no blank', () => {
    expect(readyStarter('greeting', 'Prestige Cars'))
      .toBe(AUTOMATED_MESSAGE_LABELS.greeting.starter('Prestige Cars'))
  })

  /** The review link is the operator's to give; the tap leaves that sentence out. */
  it('drops the review line from the thank-you rather than publish a gap', () => {
    expect(readyStarter('thank-you', 'Prestige Cars'))
      .toBe('Thank you for renting with Prestige Cars! We hope you enjoyed it.')
  })
})

describe('common opening hours', () => {
  it('are all hours the form would accept', () => {
    for (const pattern of SERVICE_HOURS_PATTERNS) {
      expect(readServiceHours(pattern.hours), pattern.label).toEqual(pattern.hours)
    }
  })

  /** Friday 25 and Saturday 26 September 2026, 11:00 in Dubai. */
  it('mean what their labels say', () => {
    const saturdayMorning = new Date('2026-09-26T07:00:00Z')
    const byLabel = (label: string) => SERVICE_HOURS_PATTERNS.find((p) => p.label === label)!.hours
    expect(isOpenAt(byLabel('Monday–Friday, 9am–6pm'), new Date('2026-09-25T07:00:00Z'), 'Asia/Dubai')).toBe(true)
    expect(isOpenAt(byLabel('Monday–Friday, 9am–6pm'), saturdayMorning, 'Asia/Dubai')).toBe(false)
    expect(isOpenAt(byLabel('Every day, 9am–9pm'), saturdayMorning, 'Asia/Dubai')).toBe(true)
  })
})
