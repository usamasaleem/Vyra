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

describe('policy', () => {
  const withAnswers = [
    ...given,
    'delivery-areas: We deliver anywhere in Dubai for free. Abu Dhabi is AED 300 each way. The car may be driven anywhere in the UAE, but not across the border.',
    'included-kilometres: 250 km a day are included.',
    'driver-requirements: The minimum age is 25.',
  ]
  const claims = (reply: string, sources: readonly string[] = given) =>
    checkReplyFacts(reply, { sources, booked: false, held: false }).filter((p) => p.kind === 'policy')

  it.each([
    'Delivery is free anywhere in Dubai.',
    'Kilometres are unlimited — unlimited mileage on every car.',
    'Full insurance is included.',
    'Fuel is included.',
    'Salik is included in the price.',
    'You can drive it to Oman.',
    'You cannot take it to Abu Dhabi.',
    'It comes with 300 km a day.',
    'The driver must be 21 or over.',
  ])('catches %j when nobody published it', (reply) => {
    expect(claims(reply)).not.toEqual([])
  })

  it.each([
    'Delivery is free anywhere in Dubai.',
    'You can drive it to Abu Dhabi.',
    '250 km a day are included.',
    'The driver must be 25 or over.',
  ])('passes %j when the operator said so', (reply) => {
    expect(claims(reply, withAnswers)).toEqual([])
  })

  it('does not read the rental length as a deposit promise', () => {
    expect(claims('Friday 25th, back Sunday 27th — 2 days.')).toEqual([])
    expect(claims('The deposit is returned within 14 days.')).not.toEqual([])
  })

  it.each([
    'I will check whether you can take it to Oman.',
    'The team will confirm whether delivery is free to your area.',
    'Can you tell me where you would like it delivered?',
  ])('leaves %j alone: it claims nothing', (reply) => {
    expect(claims(reply)).toEqual([])
  })
})

describe('dates', () => {
  const onRecord = ['prepare_quote: {"startDate":"2026-09-25","endDate":"2026-09-27"}', 'Customer: fri-sun']
  const dated = (reply: string, today = '2026-09-23') =>
    checkReplyFacts(reply, { sources: onRecord, booked: false, held: false, today })
      .filter((p) => p.kind === 'date' || p.kind === 'weekday')

  it('passes the dates on the quote, however they are written', () => {
    expect(dated('Friday 25th to Sunday 27th September — 2 days.')).toEqual([])
    expect(dated('That is 25–27 September.')).toEqual([])
    expect(dated('From September 25th.')).toEqual([])
  })

  it('catches a date nobody gave it', () => {
    expect(dated('Returning Monday 28th September.')).toMatchObject([{ kind: 'date' }])
  })

  /** A right date on the wrong weekday is the classic model slip. */
  it('catches the wrong weekday for a date', () => {
    expect(dated('Thursday 25th September.')).toEqual([{ kind: 'weekday', said: 'Thursday 25th September' }])
  })

  /** A quote's expiry arrives as a timestamp, "2026-09-26T19:22:00Z". */
  it('reads a date inside a timestamp', () => {
    const sources = ['prepare_quote: {"validUntil":"2026-09-26T19:22:00.000Z"}']
    expect(checkReplyFacts('This price holds until 26 September.', { sources, booked: false, held: false })
      .filter((p) => p.kind === 'date')).toEqual([])
  })

  it('works out the year across the new year', () => {
    const sources = ['prepare_quote: {"startDate":"2027-01-02"}']
    expect(checkReplyFacts('Saturday 2nd January.', { sources, booked: false, held: false, today: '2026-12-20' })
      .filter((p) => p.kind === 'weekday')).toEqual([])
  })
})
