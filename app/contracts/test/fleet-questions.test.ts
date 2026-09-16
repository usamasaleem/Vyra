import { describe, expect, it } from 'vitest'
import { mightNeedTheFleet } from '../src/fleet-questions.ts'

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
