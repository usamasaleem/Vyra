import { describe, expect, it } from 'vitest'
import { mightNeedAvailability, mightNeedTheFleet } from '../src/fleet-questions.ts'

describe('mightNeedTheFleet', () => {
  /** Every one of these is a real message from the pilot transcripts. */
  it.each([
    'show me your cars',
    'can you show me the lambo?',
    'which one has the most discount?',
    'Lamborghini Huracán, please.',
    'what is your most expensive car',
    'we are 5 people, what do you have?',
    'anything under 5,200 a day?',
    'how much is it per day',
    'i need a good car',
    'sporty',
    'can i see the lambio',
    // Asking for more of what they were already sent. This matched nothing,
    // so nothing downstream knew which car the promise was about.
    'can you send again',
    'another angle please',
  ])('looks the fleet up in advance for %j', (body) => {
    expect(mightNeedTheFleet(body)).toBe(true)
  })

  /**
   * Not everything is about cars. Being wrong here costs a database read and a
   * paragraph the model has no reason to mention — never a wrong answer, which
   * is the only kind of error worth being careful about.
   */
  it.each([
    'what is the deposit?',
    'stop messaging me',
    'thanks, speak tomorrow',
    'can I pay by card',
    'where are you based',
    'how is the weather',
  ])('does not bother for %j', (body) => {
    expect(mightNeedTheFleet(body)).toBe(false)
  })

  it('has no opinion about an empty message', () => {
    expect(mightNeedTheFleet(null)).toBe(false)
    expect(mightNeedTheFleet('   ')).toBe(false)
  })
})

/**
 * The prefetch gives the model every car and every rate, so availability is
 * the only thing search_vehicles still knows that the prompt does not. This
 * decides whether to leave that door open when the rest of the tool is
 * withheld.
 */
describe('mightNeedAvailability', () => {
  it.each([
    'is the ferrari available on the 20th?',
    'do you have it free next weekend',
    '19th to 21st please',
    'from 2026-09-20',
    'can I book it',
    'I will take it',
    'is it still open for saturday',
    'how many days can I have it',
  ])('keeps the lookup for %j', (body) => {
    expect(mightNeedAvailability(body)).toBe(true)
  })

  /** Nothing here needs a calendar, so nothing here needs the tool. */
  it.each([
    'show me your cars',
    'Ferrari 488, please.',
    'is the huracan loud',
    'what colours do you have',
    'which one is fastest',
    'can i see the lambo',
  ])('lets the lookup go for %j', (body) => {
    expect(mightNeedAvailability(body)).toBe(false)
  })

  it('says no to nothing at all', () => {
    expect(mightNeedAvailability(null)).toBe(false)
    expect(mightNeedAvailability('   ')).toBe(false)
  })
})
