import { describe, expect, it } from 'vitest'
import { buttonsFor, DATE_CONFIRMATION, DELIVERY_CHOICE, meaningOfButton } from '../src/confirmations.ts'

describe("Meta's limits", () => {
  it.each([...DATE_CONFIRMATION, ...DELIVERY_CHOICE])('$title fits in a button', (button) => {
    // A title over 20 characters is rejected at the API, months after somebody
    // made the wording friendlier.
    expect(button.title.length).toBeLessThanOrEqual(20)
    expect(button.id.length).toBeLessThanOrEqual(256)
  })

  it('never offers more than three', () => {
    expect(DATE_CONFIRMATION.length).toBeLessThanOrEqual(3)
    expect(DELIVERY_CHOICE.length).toBeLessThanOrEqual(3)
  })
})

describe('buttonsFor', () => {
  it.each([
    '15th to 18th September, Tuesday to Friday — that right?',
    'Got it — 20th to 23rd September. Is that right?',
    'You mean 15-18 September, correct?',
    'Do you mean this coming September?',
  ])('offers a date confirmation for %j', (reply) => {
    expect(buttonsFor(reply)).toEqual(DATE_CONFIRMATION)
  })

  it.each([
    'Would you like delivery, or will you collect it?',
    'Are you collecting, or shall we deliver?',
  ])('offers the delivery choice for %j', (reply) => {
    expect(buttonsFor(reply)).toEqual(DELIVERY_CHOICE)
  })

  /**
   * The restraint is the design. Buttons on an open question turn a
   * conversation into a menu, which is the product this one is not.
   */
  it.each([
    'Which dates were you thinking?',
    'Nice choice — the yellow one is the 488 Spider.',
    'The total is AED 16,500 for 3 days.',
    'What dates do you need it for?',
    'Which car are you looking at?',
    'The Rolls-Royce Cullinan is AED 8,000 per day.',
  ])('sends %j as plain text', (reply) => {
    expect(buttonsFor(reply)).toBeNull()
  })

  /** One tap cannot answer two questions, and would answer the wrong one. */
  it('declines when the reply asks more than one question', () => {
    expect(buttonsFor(
      '20th to 23rd September, is that right? And would you like delivery?',
    )).toBeNull()
  })

  it('finds nothing in an empty reply', () => {
    expect(buttonsFor(null)).toBeNull()
    expect(buttonsFor('   ')).toBeNull()
  })
})

describe('meaningOfButton', () => {
  it('turns a tap into words the conversation can carry', () => {
    expect(meaningOfButton('dates_confirmed', 'Yes, correct')).toBe('Yes, those dates are correct.')
    expect(meaningOfButton('prefers_delivery', 'Delivery')).toBe('Delivery, please.')
  })

  it('falls back to the title for a button it does not know', () => {
    expect(meaningOfButton('something_new', 'Something new')).toBe('Something new')
  })
})
