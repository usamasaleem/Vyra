import { describe, expect, it } from 'vitest'
import {
  BOOKING_CONFIRMATION, DATE_CONFIRMATION, DELIVERY_CHOICE, HIGHLIGHT_LIMIT, LIST_LIMITS, buttonsFor,
  invitesACarChoice, meaningOfButton, vehicleList,
} from '../src/confirmations.ts'

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

  /**
   * The four fixed phrases matched one reply in ninety-eight. This is the one
   * that prompted widening them: as closed a question as exists, with the dates
   * named, sent as plain text because the wording was not on the list.
   */
  it.each([
    'The Ferrari 488 Spider — AED 5,000 per day. Still looking at 19th–21st September?',
    'Still the 19th?',
    'Still those dates, 20 to 23 September?',
    'Does 19th to 21st September still work?',
    '19th September — is that your start date?',
    'Shall I keep you down for 19th to 21st September?',
  ])('offers a date confirmation for the way it actually asks: %j', (reply) => {
    expect(buttonsFor(reply)).toEqual(DATE_CONFIRMATION)
  })

  /**
   * NAMES_A_DATE is what keeps the wider shapes honest. None of them may fire
   * on a sentence with no date in it, however closed the question sounds.
   */
  it.each([
    'Still looking at the Cullinan?',
    'Is that your preference?',
    'Does that still work?',
  ])('will not offer a date confirmation with no date on the table: %j', (reply) => {
    expect(buttonsFor(reply)).toBeNull()
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

describe('vehicleList', () => {
  const FLEET = [
    { make: 'Rolls-Royce', model: 'Cullinan', variant: null, colour: 'English White',
      engine: '6.75L V12', dayRate: 'AED 8,000' },
    { make: 'Lamborghini', model: 'Huracán', variant: 'EVO Spyder',
      colour: 'Arancio Borealis (orange)', engine: '5.2L V10', dayRate: 'AED 5,500' },
    { make: 'Ferrari', model: '488', variant: 'Spider', colour: 'Giallo Modena (yellow)',
      engine: '3.9L V8', dayRate: null },
  ]

  it('builds a row per car, within every limit Meta enforces', () => {
    const list = vehicleList(FLEET)!
    expect(list.rows).toHaveLength(3)
    expect(list.button.length).toBeLessThanOrEqual(LIST_LIMITS.buttonText)
    for (const row of list.rows) {
      expect(row.title.length).toBeLessThanOrEqual(LIST_LIMITS.rowTitle)
      expect(row.description!.length).toBeLessThanOrEqual(LIST_LIMITS.rowDescription)
      expect(row.id.length).toBeLessThanOrEqual(LIST_LIMITS.rowId)
    }
  })

  it('shows the colour a customer would recognise, and the price', () => {
    const [, huracan] = vehicleList(FLEET)!.rows
    expect(huracan!.title).toBe('Lamborghini Huracán')
    // The manufacturer's gloss is dropped: "Arancio Borealis", not "(orange)".
    expect(huracan!.description).toBe('Arancio Borealis · 5.2L V10 · AED 5,500/day')
  })

  it('says nothing about a price nobody confirmed', () => {
    const [, , ferrari] = vehicleList(FLEET)!.rows
    expect(ferrari!.description).toBe('Giallo Modena · 3.9L V8')
  })

  /** One car is an answer, not a menu. */
  it('refuses to make a list of one', () => {
    expect(vehicleList([FLEET[0]!])).toBeNull()
    expect(vehicleList([])).toBeNull()
  })

  /** Meta allows ten rows; a bigger fleet is described the way a person would. */
  it('refuses a fleet too large to list', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...FLEET[0]!, model: `Car ${i}` }))
    expect(vehicleList(many)).toBeNull()
  })
})

describe('invitesACarChoice', () => {
  it.each([
    'We have three that would suit — which one appeals?',
    'Let me know which of these you like.',
    'Take your pick.',
  ])('reads %j as inviting a choice', (reply) => {
    expect(invitesACarChoice(reply)).toBe(true)
  })

  /**
   * A search returning three cars does not mean the agent asked the customer to
   * pick one. It may have been answering "what do you have in orange".
   */
  it.each([
    'We have the Cullinan, the Huracán and the 488 Spider.',
    'What dates are you looking at?',
    'The Cullinan is AED 8,000 per day.',
  ])('reads %j as an answer, not a menu', (reply) => {
    expect(invitesACarChoice(reply)).toBe(false)
  })

  /**
   * Seen from the live model: it confirmed the weekend dates and asked which
   * car in the same message. One tap answers the wrong one, and the date
   * question is left hanging.
   */
  it('declines when the reply also asks something else', () => {
    expect(invitesACarChoice(
      'I’ve got the weekend as 19th–20th September, right? Which one should I price?',
    )).toBe(false)
  })
})

describe('a tapped car', () => {
  it('comes back as a sentence the conversation can use', () => {
    const [cullinan] = vehicleList([
      { make: 'Rolls-Royce', model: 'Cullinan', variant: null, colour: 'English White',
        engine: '6.75L V12', dayRate: 'AED 8,000' },
      { make: 'Ferrari', model: '488', variant: 'Spider', colour: 'Giallo Modena (yellow)',
        engine: '3.9L V8', dayRate: 'AED 5,000' },
    ])!.rows
    expect(meaningOfButton(cullinan!.id, cullinan!.title)).toBe('Rolls-Royce Cullinan, please.')
  })
})

/**
 * A few words the operator wants beside a car.
 *
 * A WhatsApp list row has no badge and no tag — id, a 24-character title and a
 * 72-character description, and that is the whole of it. The description is
 * the only place this can go, and the colour, engine and rate already use
 * about fifty of those characters.
 */
describe('a highlight on a list row', () => {
  const cars = (highlight: string | null) => [
    {
      make: 'Lamborghini', model: 'Huracán', variant: 'Tecnica', colour: 'Verde',
      engine: '5.2 L V10', dayRate: 'AED 5,500', highlight,
    },
    {
      make: 'Ferrari', model: '488', variant: 'Spider', colour: 'Giallo Modena',
      engine: '3.9 L V8', dayRate: 'AED 5,000', highlight: null,
    },
  ]

  it('reads first, because that is the point of it', () => {
    const list = vehicleList(cars('Best seller'))
    expect(list!.rows[0]!.description)
      .toBe('Best seller · Verde · 5.2 L V10 · AED 5,500/day')
  })

  it('leaves a car without one exactly as it was', () => {
    const list = vehicleList(cars('Best seller'))
    expect(list!.rows[1]!.description).toBe('Giallo Modena · 3.9 L V8 · AED 5,000/day')
  })

  it.each([null, '', '   '])('treats %j as none at all', (highlight) => {
    const list = vehicleList(cars(highlight))
    expect(list!.rows[0]!.description).toBe('Verde · 5.2 L V10 · AED 5,500/day')
  })

  /** Longer than this and the engine starts disappearing to make room. */
  it('never spends more than the limit on it', () => {
    const first = vehicleList(cars('The one everybody in Dubai asks us about'))!.rows[0]!
    expect(first.description!.startsWith('The one everybody')).toBe(true)
    expect(first.description!.split(' · ')[0]!.length).toBeLessThanOrEqual(HIGHLIGHT_LIMIT)
  })

  it('still fits the row WhatsApp allows', () => {
    for (const row of vehicleList(cars('Best seller'))!.rows) {
      expect(row.description!.length).toBeLessThanOrEqual(LIST_LIMITS.rowDescription)
    }
  })
})

/**
 * "Book it" has nowhere to go: request_booking_review is a stub that refuses,
 * there is no bookings table, and booking_status is read in six places and
 * written in none. A button saying "Book now" would drive somebody into that
 * wall faster and more confidently than typing would.
 */
describe('the booking buttons', () => {
  it('promises a person, not a booking', () => {
    const titles = BOOKING_CONFIRMATION.map((b) => b.title)
    expect(titles).toEqual(['Confirm with team', 'Not just yet'])
    for (const title of titles) expect(title).not.toMatch(/\bbook(ed|ing)?\b/i)
  })

  /** One option is not a choice, and somebody nearly ready needs a way out. */
  it('offers a way that is not yes', () => {
    expect(BOOKING_CONFIRMATION).toHaveLength(2)
  })

  it.each(BOOKING_CONFIRMATION)('$title fits in a WhatsApp button', (button) => {
    expect(button.title.length).toBeLessThanOrEqual(20)
  })

  it('turns a tap into words the conversation can carry', () => {
    expect(meaningOfButton('booking_confirm', 'Confirm with team'))
      .toBe('Yes — please have someone confirm this booking.')
    expect(meaningOfButton('booking_wait', 'Not just yet')).toBe('Not just yet.')
  })
})
