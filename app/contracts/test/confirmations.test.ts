import { describe, expect, it } from 'vitest'
import {
  BOOKING_CONFIRMATION, DATE_CONFIRMATION, DELIVERY_CHOICE, HIGHLIGHT_LIMIT, LIST_LIMITS, buttonsFor,
  BOOKING_NOW, asksToBook, invitesACarChoice, meaningOfButton, offersAChoice, surfaceForAsking,
  vehicleList,
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

  /**
   * The same tap means the same thing whichever label it carried, because the
   * id is what travels. "Please have someone confirm this" was the old
   * wording and describes a hand-off that does not happen when the agent
   * settles the booking itself.
   */
  it('turns a tap into words the conversation can carry', () => {
    expect(meaningOfButton('booking_confirm', 'Confirm with team'))
      .toBe('Yes — please confirm this booking.')
    expect(meaningOfButton('booking_confirm', 'Yes, book it'))
      .toBe('Yes — please confirm this booking.')
    expect(meaningOfButton('booking_wait', 'Not just yet')).toBe('Not just yet.')
  })

  /**
   * "Confirm with team" promises a person who is not coming when the operator
   * has switched auto-confirm on, and a button describing a hand-off the
   * customer will never experience invites them to wait for it.
   */
  it.each(BOOKING_NOW)('$title fits in a WhatsApp button', (button) => {
    expect(button.title.length).toBeLessThanOrEqual(20)
  })

  it('offers the same ids either way, so the turn reads one thing', () => {
    expect(BOOKING_NOW.map((b) => b.id)).toEqual(BOOKING_CONFIRMATION.map((b) => b.id))
    expect(BOOKING_NOW[0]!.title).not.toBe(BOOKING_CONFIRMATION[0]!.title)
  })
})

/**
 * The surface for the question the agent was told to ask.
 *
 * Every other matcher here reads the model's prose and infers what it meant,
 * and that has failed repeatedly: the car list missed "Which one would you
 * like to see?", the date confirmation matched one reply in ninety-eight. This
 * reads the instruction the model was given instead.
 */
describe('surfaceForAsking', () => {
  it.each([
    'Would you like it delivered, or will you collect it?',
    'The Cullinan is AED 8,000 a day. Shall we bring it to you, or would you rather pick it up?',
    'Yes, it seats five comfortably. Are you collecting it or shall we deliver?',
    'Happy to drop it anywhere in Dubai — delivery or collection?',
  ])('offers the delivery buttons for %j', (reply) => {
    expect(surfaceForAsking('delivery_preference', reply)).toBe('delivery_choice')
  })

  it.each([
    'The range is small but nice. Which one takes your fancy?',
    'We have three. Which would suit you best?',
    'All three are quick — any of them interest you?',
  ])('offers the car list for %j', (reply) => {
    expect(surfaceForAsking('vehicle', reply)).toBe('car_list')
  })

  /**
   * The instruction says what the model was told to ask, not that it asked.
   * The same instruction tells it to drop a question passed over twice, so the
   * words still have to mention the thing.
   */
  it('says nothing when the reply went somewhere else', () => {
    expect(surfaceForAsking('delivery_preference', 'What dates were you thinking?')).toBeNull()
    expect(surfaceForAsking('vehicle', 'The Cullinan is AED 8,000 per day.')).toBeNull()
  })

  /**
   * Live: Delivery / Collection under a question about paying, because the
   * word was in the sentence before it.
   */
  it('does not offer the fleet under a question about booking', () => {
    expect(surfaceForAsking('vehicle',
      'The Cullinan is AED 16,000 for 2 days. Would you like me to book it now, or hold it for you for 2 hours?',
    )).toBeNull()
  })

  it('reads the question, not the statement in front of it', () => {
    expect(surfaceForAsking('delivery_preference',
      'Perfect — collection at 4:00 pm on Thursday. How would you like to pay the AED 20,000 due?',
    )).toBeNull()
  })

  /** Only two questions have a surface. A date is open, and a menu cannot hold one. */
  it.each(['start_at', 'end_at', 'duration', 'budget'])(
    'has nothing to offer for %j', (field) => {
      expect(surfaceForAsking(field, 'When would you like it, and for how long?')).toBeNull()
    },
  )

  /** One tap cannot answer two questions. */
  it('declines a reply that asks more than one thing', () => {
    expect(surfaceForAsking(
      'delivery_preference',
      'Delivered or collected? And what dates were you thinking?',
    )).toBeNull()
  })

  it('says nothing when nothing was asked', () => {
    expect(surfaceForAsking(undefined, 'Delivered or collected?')).toBeNull()
    expect(surfaceForAsking('delivery_preference', null)).toBeNull()
    expect(surfaceForAsking('delivery_preference', '  ')).toBeNull()
  })
})

/**
 * The surface has to answer the question above it.
 *
 * Read out of two screenshots, minutes apart, at the moment of a sale. The
 * agent asked "Ferrari 488 Spider from 25th to 27th September is *2 rental
 * days* — or do you need 3 days?" and carried `Confirm with team` /
 * `Not just yet`. The customer tapped Confirm with team, which answers
 * nothing about 2 or 3, and got the same question back with the same buttons.
 * Then "25th–27th September is 2 days, while 3 days would be 25th–28th
 * September. Which one should I use?" went out with a tappable list of the
 * fleet under it.
 *
 * Every one of these is the same failure: the affordance was chosen from
 * something other than the question being asked.
 */
describe('a surface that cannot answer its own question', () => {
  const askedTwoOrThree =
    'Just to confirm: *Ferrari 488 Spider* delivered from 25th to 27th September is '
    + '*2 rental days* — or do you need 3 days, through the 27th?'
  const askedWhichDates =
    'I still need the dates to match before I can send it for confirmation: 25th–27th '
    + 'September is 2 days, while 3 days would be 25th–28th September. Which one should I use?'

  it('sees the two-or-three question as a choice', () => {
    expect(offersAChoice(askedTwoOrThree)).toBe(true)
  })

  it('does not call a plain confirmation prompt a choice', () => {
    expect(offersAChoice('Shall I have a colleague confirm this for you?')).toBe(false)
    expect(offersAChoice('That is all noted — I will pass it to the team now.')).toBe(false)
  })

  it('keeps the fleet list away from a question about dates', () => {
    expect(invitesACarChoice(askedWhichDates)).toBe(false)
  })

  /** The reply that made requiring a car name the wrong fix. */
  it('still offers the list when the cars are the choice', () => {
    expect(invitesACarChoice('We have three that would suit — which one appeals?')).toBe(true)
    expect(invitesACarChoice('Which one would you like, the Ferrari or the Huracán?')).toBe(true)
  })

  /** A named car wins even where days are being discussed. */
  it('offers the list when a car is named alongside the dates', () => {
    expect(invitesACarChoice(
      'For 3 days I would take the Huracán over the Cullinan — which one shall I price?',
    )).toBe(true)
  })
})

/**
 * Live: "Would you like me to book the Ferrari 488 Spider for 24th–25th
 * September?" went out as plain text, because the buttons only looked at
 * whether the customer's message sounded like a booking.
 */
describe('a reply that asks to book', () => {
  it.each([
    'No problem — collection it is. Would you like me to book the *Ferrari 488 Spider* for 24th–25th September?',
    'The Ferrari is free for those dates. Shall I book it for you?',
    'Do you want me to reserve it?',
    'Ready to book?',
    'هل تريد أن أحجزها لك؟',
    'It is AED 15,000 for 3 days. Shall I book it now, or hold it for you for 2 hours?',
    'AED 10,000 total. The driver needs to be 25 or over. I can book it now, or hold it for you for 2 hours.',
    '1st to 3rd October — 2 days, right? Total: AED 11,000. Would you like me to book it now, or hold it for you for 2 hours?',
  ])('is recognised: %s', (reply) => {
    expect(asksToBook(reply)).toBe(true)
  })

  it.each([
    // A choice between cars is not a yes.
    'Shall I book the Ferrari or the Huracán?',
    // Two questions cannot be answered by one tap.
    'Shall I book it? And would you like it delivered?',
    'Booked — it is confirmed and held for you.',
    'What dates are you thinking?',
    null,
  ])('is not: %s', (reply) => {
    expect(asksToBook(reply)).toBe(false)
  })
})
