import { describe, expect, it } from 'vitest'
import { detectDiscountRequest } from '../src/discount.ts'

describe('detectDiscountRequest', () => {
  /** The eval case, which the agent answered by starting a negotiation. */
  it('catches an offer of a specific number', () => {
    expect(detectDiscountRequest('can you do 3000 for the weekend instead?')).toMatchObject({
      reason: 'The customer asked for a discount or a better price',
    })
  })

  it.each([
    'any discount for a week?',
    'whats your best price',
    'can you do better on the rate?',
    'is the price negotiable',
    'anything cheaper?',
    'any deals this month',
    'can you lower the price a bit',
    'special price for 5 days?',
    'I will take it for 2500 instead',
    'في خصم؟',
  ])('reads %j as asking for a discount', (text) => {
    expect(detectDiscountRequest(text)).not.toBeNull()
  })

  /**
   * The false positives that would matter. Each is an ordinary sales question,
   * and turning it into a handoff would make the agent more deferential — the
   * precise failure the higher-effort model was rejected for.
   */
  it.each([
    'what is your cheapest car?',
    'how much is the Huracan per day?',
    'what is the price for 3 days',
    'is the deposit refundable?',
    'can you do delivery to Marina?',
    'do you have anything available this weekend?',
    'what cars do you have',
  ])('does not read %j as asking for a discount', (text) => {
    expect(detectDiscountRequest(text)).toBeNull()
  })

  it('finds nothing in an empty message', () => {
    expect(detectDiscountRequest(null)).toBeNull()
    expect(detectDiscountRequest('  ')).toBeNull()
  })
})
