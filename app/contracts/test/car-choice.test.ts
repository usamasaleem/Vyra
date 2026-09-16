import { describe, expect, it } from 'vitest'
import { carChosenIn, carsNamedIn } from '../src/car-choice.ts'

const FLEET = [
  { make: 'Rolls-Royce', model: 'Cullinan', variant: null },
  { make: 'Lamborghini', model: 'Huracán', variant: 'Tecnica' },
  { make: 'Ferrari', model: '488', variant: 'Spider' },
]

const chosen = (message: string | null) => carChosenIn(message, FLEET)?.model ?? null

describe('carsNamedIn', () => {
  it('finds a car by its model', () => {
    expect(carsNamedIn('the cullinan', FLEET).map((c) => c.model)).toEqual(['Cullinan'])
  })

  /** "Huracan" must find "Huracán". A customer typed it and was told we had no such car. */
  it('ignores accents', () => {
    expect(carsNamedIn('huracan please', FLEET).map((c) => c.model)).toEqual(['Huracán'])
  })

  it.each(['lambo', 'lambio', 'rolls', 'roller'])('knows %j', (nickname) => {
    expect(carsNamedIn(nickname, FLEET)).toHaveLength(1)
  })

  it('finds both when both are named', () => {
    expect(carsNamedIn('cullinan or the lambo?', FLEET)).toHaveLength(2)
  })

  it('finds none in a message about neither', () => {
    expect(carsNamedIn('what is the deposit?', FLEET)).toEqual([])
  })
})

describe('carChosenIn', () => {
  /** Every one of these is a real message from the pilot transcripts. */
  it.each([
    ['actually the cullinan', 'Cullinan'],
    ['Rolls-Royce Cullinan, please.', 'Cullinan'],
    ['Lamborghini Huracán, please.', 'Huracán'],
    ['lambo', 'Huracán'],
    ["i'll take the ferrari", '488'],
    ['make it the cullinan', 'Cullinan'],
  ])('reads %j as choosing the %s', (message, model) => {
    expect(chosen(message)).toBe(model)
  })

  /**
   * The failure this exists for. "it's popular as compared to lambo?" flipped
   * the enquiry back to the Huracán after the customer had moved to the
   * Cullinan — a comparison read as a decision.
   */
  it.each([
    "it's popular as compared to lambo?",
    'is the lambo good for dubai roads?',
    'how much is the cullinan per day',
    'can i see the lambo',
    'does the ferrari have more power than the lambo',
  ])('reads %j as mentioning rather than choosing', (message) => {
    expect(chosen(message)).toBeNull()
  })

  /** Two cars named is a comparison whatever else the sentence says. */
  it('chooses nothing when two are named', () => {
    expect(chosen('actually the cullinan or the lambo')).toBeNull()
  })

  it('chooses nothing in a message about no car', () => {
    expect(chosen('what is the deposit?')).toBeNull()
    expect(chosen(null)).toBeNull()
  })
})
