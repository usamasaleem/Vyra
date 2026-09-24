import { describe, expect, it } from 'vitest'
import { checkReplyFacts } from '../src/turn/fact-check.ts'

/**
 * A reply read back against what the agent was given. Each case is the kind
 * of sentence that has, or would have, reached a customer wrong.
 */
const given = [
  'prepare_quote: {"total":"AED 10,000","deposit":"AED 5,000","days":2}',
  'The operator takes 10% off 5+ days, 15% off 7+ days.',
  'Customer: can you do it for 8000?',
]
const check = (reply: string, over: { booked?: boolean; held?: boolean } = {}) =>
  checkReplyFacts(reply, { sources: given, booked: over.booked ?? false, held: over.held ?? false })

describe('figures', () => {
  it('passes figures the tools gave', () => {
    expect(check('The total is *AED 10,000*, with a AED 5,000 deposit.')).toEqual([])
  })

  /** Simulated: "twin-turbo V8, AED 5,000 per day" was read as "8 AED". */
  it('does not read an engine name as an amount', () => {
    expect(check('The Ferrari — 3.9 L twin-turbo V8, AED 10,000 for the two days.')).toEqual([])
  })

  it('catches a figure nobody gave it', () => {
    expect(check('The deposit is AED 3,000.')).toEqual([{ kind: 'amount', said: 'AED 3,000' }])
  })

  /** No sums of its own: rental plus deposit is the tool's to say. */
  it('catches arithmetic it did itself', () => {
    expect(check('That is AED 15,000 all in.')).toEqual([{ kind: 'amount', said: 'AED 15,000' }])
  })

  it('lets it repeat the customer’s own number back', () => {
    expect(check('I can’t do AED 8,000, I’m afraid.')).toEqual([])
  })

  it('catches a percentage nobody offered', () => {
    expect(check('I can do 20% off.')).toEqual([{ kind: 'percent', said: '20% off'.slice(0, 3) }])
  })
})

describe('claims', () => {
  it('catches "booked" with no booking', () => {
    expect(check('Booked — the Ferrari is yours for Friday.')).toMatchObject([{ kind: 'booked' }])
    expect(check('Your Ferrari 488 Spider is confirmed for Friday.')).toMatchObject([{ kind: 'booked' }])
  })

  it('lets it say what is not booked, or somebody else’s booking', () => {
    expect(check('It is not booked yet — shall I book it?')).toEqual([])
    expect(check('The Ferrari has since been booked for those dates.')).toEqual([])
    expect(check('Once it is confirmed, I will send the details.')).toEqual([])
  })

  it('passes "booked" when it is', () => {
    expect(check('Booked — the Ferrari is yours for Friday.', { booked: true })).toEqual([])
  })

  it('catches "held" with no hold', () => {
    expect(check('The Ferrari is held for you until 18:00.')).toMatchObject([{ kind: 'held' }])
    expect(check('The Ferrari is held for you until 18:00.', { held: true })).toEqual([])
  })
})
