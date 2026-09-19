import { describe, expect, it } from 'vitest'
import { hasUnfilledBlank, isPolicyTopic, POLICY_TOPICS } from '../src/policy-topics.ts'

describe('the closed list of topics', () => {
  it('accepts one on the list', () => {
    expect(isPolicyTopic('deposit')).toBe(true)
  })

  /**
   * The list is closed so that a typo is a refusal rather than an answer filed
   * under a subject nothing will ever ask for.
   */
  it('refuses anything else', () => {
    expect(isPolicyTopic('deposits')).toBe(false)
    expect(isPolicyTopic('greeting')).toBe(false)
  })

  it('holds only what the agent can be asked', () => {
    expect(POLICY_TOPICS).toContain('deposit')
    expect(POLICY_TOPICS).not.toContain('follow-up-message')
  })
})

/**
 * Four of the six policy answers are the operator's own figures, so their
 * starters carry the shape of the sentence with the numbers left out. That
 * turns "write six policy answers from scratch" into "fill in six forms"
 * without anybody inventing anything — and it only works if a blank cannot
 * reach a customer.
 */
describe('a blank left in a starter', () => {
  it('is caught wherever it sits in the sentence', () => {
    expect(hasUnfilledBlank('The security deposit is ___, held on a credit card.')).toBe(true)
    expect(hasUnfilledBlank('___ kilometres a day are included.')).toBe(true)
    expect(hasUnfilledBlank('Somebody is at the desk 9am to 7pm, and delivery is possible ___'))
      .toBe(true)
  })

  it('leaves a finished answer alone', () => {
    expect(hasUnfilledBlank('The security deposit is AED 5,000, held on a credit card.'))
      .toBe(false)
  })

  /** An underscore is a normal character; two of them are not the marker. */
  it('does not fire on ordinary punctuation', () => {
    expect(hasUnfilledBlank('Email us at bookings_dubai@example.com')).toBe(false)
    expect(hasUnfilledBlank('Rate is 5,000 __ per day')).toBe(false)
  })
})
