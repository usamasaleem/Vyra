import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../src/turn/prompt.ts'

/**
 * What the model is handed about its own past messages.
 *
 * Read out of a real transcript: "I sent you 7 photos of the Lamborghini
 * Huracán on the 15th", three times in six minutes, once with the count
 * changed to 9. The model was not inventing — it was repeating the fact it had
 * been given, which read "7 of the Lamborghini Huracán on 15 September".
 *
 * A model repeats the precision it is handed. So the test is on the fact.
 */
const now = new Date('2026-09-16T10:00:00Z')

const prompt = (photosShown: Parameters<typeof systemPromptFor>[0]['photosShown']) =>
  systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', photosShown })

describe('what it is told about photographs it has sent', () => {
  const huracan = {
    make: 'Lamborghini', model: 'Huracán', sent: 7,
    lastSentAt: new Date('2026-09-16T04:00:00Z'),
  }

  it('says when, the way a person says it', () => {
    expect(prompt([huracan])).toContain('the Lamborghini Huracán earlier today')
  })

  /**
   * Asserted on the sentence we inject rather than on the whole prompt, which
   * legitimately contains a September in a date-confirmation example. Testing
   * the whole thing caught that — and also caught the instruction itself
   * quoting "7 photos on 16 September" as what not to say, which is a negative
   * example priming exactly the words it forbids.
   */
  const fact = (shown: Parameters<typeof prompt>[0]) => {
    const text = prompt(shown)
    const from = text.indexOf('already sent this customer')
    return from === -1 ? '' : text.slice(from, from + 240)
  }

  /** Nobody counts their own photographs out loud. */
  it('never hands over a count', () => {
    expect(fact([huracan])).not.toMatch(/\d/)
  })

  it('never hands over a date', () => {
    expect(fact([{ ...huracan, lastSentAt: new Date('2026-09-13T04:00:00Z') }]))
      .toContain('on Sunday')
    expect(fact([huracan])).not.toContain('September')
  })

  it('names both cars when both have been shown', () => {
    const text = prompt([
      huracan,
      { make: 'Ferrari', model: '488', sent: 3, lastSentAt: new Date('2026-09-15T04:00:00Z') },
    ])
    expect(text).toContain('the Lamborghini Huracán earlier today, and the Ferrari 488 yesterday')
  })

  it('says nothing at all when nothing has been sent', () => {
    expect(prompt([])).not.toContain('already sent this customer')
  })

  /**
   * Asked twice to see the Lamborghini again, the replies were "I'll resend
   * them with different angles" and "I'll arrange some different angles for
   * you". No photograph followed either, nothing recorded the promise, and
   * there was nothing to arrange: the operator has four pictures of that car.
   */
  it('forbids offering angles that do not exist', () => {
    const text = prompt([huracan])
    expect(text).toContain('all there is')
    expect(text).toContain('never offer to find, arrange or resend different ones')
  })

  it('says nothing about sourcing photographs when none have been sent', () => {
    expect(prompt([])).not.toContain('never offer to find, arrange or resend')
  })
})

/**
 * The customer picked the Ferrari off the list and asked to see it. The reply
 * was "the yellow Ferrari 488 Spider is the convertible in the photos" — and
 * the only photographs they had ever been sent were of the Lamborghini, an hour
 * earlier. There are none of the Ferrari at all.
 */
describe('cars there are no photographs of', () => {
  const withMissing = (noPhotosOf: readonly string[]) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', noPhotosOf })

  it('names the one car', () => {
    const text = withMissing(['Ferrari 488'])
    expect(text).toContain('There are no photographs of the Ferrari 488.')
  })

  it('names two of them the way a person lists two', () => {
    expect(withMissing(['Ferrari 488', 'Rolls-Royce Cullinan']))
      .toContain('no photographs of the Ferrari 488 or the Rolls-Royce Cullinan')
  })

  it('uses commas for three and "or" only before the last', () => {
    expect(withMissing(['Aston Martin DB11', 'Ferrari 488', 'Rolls-Royce Cullinan']))
      .toContain('the Aston Martin DB11, the Ferrari 488 or the Rolls-Royce Cullinan')
  })

  /** The exact sentence that went out, forbidden by name. */
  it('forbids pointing at another car\u2019s photographs', () => {
    const text = withMissing(['Ferrari 488'])
    expect(text).toContain('in the photos')
    expect(text).toContain('never point at photographs of a different car')
    expect(text).toContain('offer to have some sent over')
  })

  it('says nothing when every car has photographs', () => {
    expect(withMissing([])).not.toContain('There are no photographs of')
    expect(systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1' }))
      .not.toContain('There are no photographs of')
  })
})

/**
 * Every reply in the transcript opened with an acknowledgement — five
 * different words doing one identical move, without exception.
 */
describe('the instruction about opening a message', () => {
  it('tells it not to open every message the same way', () => {
    const text = prompt([])
    expect(text).toContain('Do not open every message the same way')
    expect(text).toContain('Of course')
  })
})

/**
 * The name has been fetched on every turn since the worker was written, used
 * by the inbox and the handoff packet, and dropped at the prompt boundary. The
 * agent has never known who it was talking to.
 */
describe('the customer\u2019s name', () => {
  const withName = (customerName: string | null) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', customerName })

  it('tells the model what they are called', () => {
    expect(withName('Layla')).toContain("This customer's WhatsApp name is Layla")
  })

  /**
   * Restraint, not a fact left lying about. A model handed a name opens every
   * message with it, which is the same tell v14 had to stop with the varied
   * openers.
   */
  it('says to use it sparingly', () => {
    const text = withName('Layla')
    expect(text).toContain('when it lands naturally')
    expect(text).toContain('Every message is worse than none')
  })

  /** It is what they chose to be shown as, not proof of anything. */
  it('refuses to let it stand as identity', () => {
    expect(withName('Layla')).toContain('never treat it as proof of who they are')
  })

  it('says nothing when there is no name', () => {
    expect(withName(null)).not.toContain('WhatsApp name is')
    expect(systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1' }))
      .not.toContain('WhatsApp name is')
  })

  /** The pilot's own contact row has the phone number in this field. */
  it('says nothing when the name is really a phone number', () => {
    expect(withName('+971501234567')).not.toContain('WhatsApp name is')
  })
})

/**
 * Live, a customer asked "is it popular compared to lambo", "what other cars
 * are good too" and "give me the highest priced". That is shopping, not
 * confusion, and a recap would hand them the work of deciding.
 */
describe('two cars in play', () => {
  const weighing = (considering: string[]) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', considering })

  it('names both and asks for a reason to pick one', () => {
    const text = weighing(['Rolls-Royce Cullinan', 'Lamborghini Huracán Tecnica'])
    expect(text).toContain('Rolls-Royce Cullinan and Lamborghini Huracán Tecnica')
    expect(text).toContain('give them the reason to pick one')
  })

  /** The whole point: a recap is the weak version and reads as having lost track. */
  it('forbids listing it back and asking which', () => {
    expect(weighing(['Rolls-Royce Cullinan', 'Ferrari 488 Spider']))
      .toContain('Do not list back what they have looked at and ask which')
  })

  it('says nothing about comparing when there is only one car', () => {
    expect(weighing(['Rolls-Royce Cullinan'])).not.toContain('They have been looking at')
    expect(weighing([])).not.toContain('They have been looking at')
  })
})

/**
 * The one place a summary belongs: not during browsing, where it interrupts,
 * but at the last moment before a person gets involved and a wrong detail
 * becomes an expensive phone call.
 */
describe('the moment before a person takes over', () => {
  const ready = (readyToConfirm: boolean) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', readyToConfirm })

  it('asks for the whole arrangement in one line', () => {
    const text = ready(true)
    expect(text).toContain('Say the whole arrangement back')
    expect(text).toContain('the car, the dates, delivery or collection')
  })

  /** request_booking_review is a stub. Nothing here may claim otherwise. */
  it('still refuses to claim anything is booked', () => {
    expect(ready(true)).toContain('must not say it is booked')
  })

  it('says nothing until they have said yes', () => {
    expect(ready(false)).not.toContain('Say the whole arrangement back')
  })
})

/**
 * What it is told when a customer is taking two cars at once.
 *
 * Read out of the same transcript. The reply named both cars correctly and the
 * record kept one, so the second rental's dates survived only as a sentence in
 * a free-text field. The prompt now describes each booking separately, and
 * carries each enquiry id, because a price for "the Cullinan and the
 * Lamborghini" is not a price either of them can be given.
 */
describe('two rentals in one thread', () => {
  const said = new Date('2026-09-16T09:00:00Z')
  const bookings = [
    {
      enquiryId: 'e-lambo',
      vehicle: 'Lamborghini Huracán Tecnica',
      known: [{ field: 'start_at', value: '2026-09-20', since: said }],
    },
    {
      enquiryId: 'e-rolls',
      vehicle: 'Rolls-Royce Cullinan',
      known: [{ field: 'start_at', value: '2026-09-22', since: said }],
    },
  ]

  const twoCars = (extra: Partial<Parameters<typeof systemPromptFor>[0]> = {}) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e-lambo', bookings, ...extra })

  it('describes each car with its own dates', () => {
    const text = twoCars()
    expect(text).toContain('Lamborghini Huracán Tecnica')
    expect(text).toContain('Rolls-Royce Cullinan')
    expect(text).toContain('e-rolls')
  })

  /** The question that was asked four times, now answerable. */
  it('names the car in the question it is told to ask', () => {
    const text = twoCars({
      stillNeeded: [{ field: 'end_at', timesAsked: 0, vehicle: 'Rolls-Royce Cullinan' }],
    })
    expect(text).toContain('or how many days, for the Rolls-Royce Cullinan')
  })

  /** One booking is the ordinary case and must read exactly as it did. */
  it('says nothing about keeping them apart when there is only one', () => {
    const text = systemPromptFor({
      now,
      timezone: 'Asia/Dubai',
      enquiryId: 'e1',
      known: [{ field: 'start_at', value: '2026-09-20', since: said }],
    })
    expect(text).not.toContain('cars at once')
    expect(text).toContain('This enquiry already has:')
  })
})

/**
 * The price already on the table, and whether a yes can find it.
 *
 * The model only ever knew a quote id it had been handed by prepare_quote in
 * the same turn, so a quote a person sent was invisible to it. Once a
 * salesperson could take five hundred off and send 9,500, that became a way to
 * lose money: the customer says "yes, book it" and the model has no id for the
 * figure they agreed to — so it prices a fresh draft at the full amount, or
 * passes something that is not an id at all and kills the turn.
 */
describe('a price somebody else sent', () => {
  const withQuote = (over: Partial<{ discounted: boolean; sent: boolean }> = {}) =>
    systemPromptFor({
      now,
      timezone: 'Asia/Dubai',
      enquiryId: 'e1',
      liveQuote: {
        quoteId: '2db2ffbc-172d-41b9-b127-207ff4ed113e',
        total: 'AED 9,500',
        discounted: over.discounted ?? true,
        sent: over.sent ?? true,
      },
    })

  it('states the id rather than describing how to find one', () => {
    expect(withQuote()).toContain('2db2ffbc-172d-41b9-b127-207ff4ed113e')
  })

  it('carries the figure the customer is actually holding', () => {
    expect(withQuote()).toContain('AED 9,500')
  })

  it('says a colleague reduced it, so it is not re-derived from the rate', () => {
    expect(withQuote()).toContain('a colleague reduced')
    expect(withQuote({ discounted: false })).not.toContain('a colleague reduced')
  })

  /** A draft nobody has sent is not a price the customer has been given. */
  it('says nothing about a quote that has not gone out', () => {
    expect(withQuote({ sent: false })).not.toContain('2db2ffbc')
  })
})

/**
 * Read live, and the round trip the setting exists to remove.
 *
 * "The Ferrari 488 Spider is free for 25th–27th September — 2 days at AED
 * 10,000, with a AED 5,000 deposit. Would you like me to send it to the team
 * for confirmation?" — and then it booked it itself a minute later. The
 * customer had already said book it. The instruction said "you cannot book
 * anything yourself", which was true of everybody when it was written and is
 * false for an operator who has switched auto-confirm on.
 */
describe('when the agent may settle a booking itself', () => {
  const atTheDecision = (mayConfirmBookings: boolean) =>
    systemPromptFor({
      now, timezone: 'Asia/Dubai', enquiryId: 'e1',
      readyToConfirm: true,
      mayConfirmBookings,
    })

  it('tells it to book rather than ask permission', () => {
    const text = atTheDecision(true)
    expect(text).toContain('Then book it')
    expect(text).toContain('do not ask whether they would like you to send it')
    expect(text).not.toContain('You cannot book anything yourself')
  })

  /** Unchanged for an operator who has not switched it on, which is most. */
  it('keeps the old rule when it may not', () => {
    const text = atTheDecision(false)
    expect(text).toContain('You cannot book anything yourself')
    expect(text).not.toContain('Then book it')
  })

  it('says nothing either way until they are at the decision', () => {
    const text = systemPromptFor({
      now, timezone: 'Asia/Dubai', enquiryId: 'e1', mayConfirmBookings: true,
    })
    expect(text).not.toContain('Then book it')
  })
})

/**
 * The offer came before the decision.
 *
 * Read live on sales-v23, the version that fixed the decision itself: "The
 * Ferrari 488 Spider is free for 25th–27th September … Shall I send it to the
 * team for confirmation?" — in reply to the price, before the customer had
 * said yes, so the decision block had not appeared yet. The customer answered
 * "yeds" and the agent booked it on the spot. The team was never involved.
 */
describe('an agent that settles bookings, at any point in the conversation', () => {
  it('never offers the team, even before they have said yes', () => {
    const text = systemPromptFor({
      now, timezone: 'Asia/Dubai', enquiryId: 'e1', mayConfirmBookings: true,
    })
    expect(text).toContain('never offer to send anything to the team')
  })

  it('says nothing of the kind for an operator whose people confirm', () => {
    const text = systemPromptFor({
      now, timezone: 'Asia/Dubai', enquiryId: 'e1', mayConfirmBookings: false,
    })
    expect(text).not.toContain('never offer to send anything to the team')
  })
})

/**
 * A transcript is what was said, not what is true now.
 *
 * Read live: a booking cancelled overnight, and in the morning the agent told
 * the customer "your Ferrari 488 Spider is already confirmed for 25th–27th
 * September" — calling nothing, because last night's "Confirmed — booked and
 * held" was still in the conversation and nothing had ever said otherwise.
 */
describe('what is booked, from the record', () => {
  const withBookings = (bookingsOnFile: Parameters<typeof systemPromptFor>[0]['bookingsOnFile']) =>
    systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', bookingsOnFile })

  it('says plainly when a booking they had is gone', () => {
    const text = withBookings({ live: [], everHadOne: true })
    expect(text).toContain('They have NO booking right now')
    expect(text).toContain('Do not tell them they are booked')
  })

  it('lists what they do have, and nothing else counts', () => {
    const text = withBookings({
      live: [{ vehicle: 'Ferrari 488 Spider', startDate: '2026-09-25', endDate: '2026-09-27', state: 'confirmed' }],
      everHadOne: true,
    })
    expect(text).toContain('Ferrari 488 Spider')
    expect(text).toContain('confirmed')
    expect(text).toContain('Do not describe anything else as booked')
  })

  /** For somebody who has never booked, "no booking" is noise. */
  it('says nothing to a customer who never had one', () => {
    const text = withBookings({ live: [], everHadOne: false })
    expect(text).not.toContain('NO booking')
  })
})

/**
 * The agent stopped at "Booked". The address, the time, the documents and the
 * money all fell to a salesperson messaging the customer again.
 */
describe('after the booking', () => {
  const after = (over: Partial<NonNullable<Parameters<typeof systemPromptFor>[0]['afterBooking']>> = {}) =>
    systemPromptFor({
      now, timezone: 'Asia/Dubai', enquiryId: 'e1',
      afterBooking: {
        vehicle: 'Ferrari 488 Spider',
        missing: ['the address the car should go to', 'a photo of their driving licence'],
        owed: 'AED 15,000',
        paymentInstructions: 'Bank transfer to Emirates NBD, IBAN AE12 3456.',
        paymentLink: null,
        ...over,
      },
    })

  it('asks for the first missing thing, one at a time', () => {
    const text = after()
    expect(text).toContain('the address the car should go to')
    expect(text).toContain('ask for the first of these only')
  })

  it('offers the operator’s own payment words, verbatim', () => {
    expect(after()).toContain('Bank transfer to Emirates NBD, IBAN AE12 3456.')
  })

  /** An account number is the operator's to write, never the agent's. */
  it('says a colleague will send details when none are published', () => {
    const text = after({ paymentInstructions: null })
    expect(text).toContain('do not make up an account')
  })

  it('never lets it claim to have checked a document or a payment', () => {
    const text = after()
    expect(text).toContain('never say you can see, read or approve a document')
    expect(text).toContain('never that it has')
  })

  it('says nothing once the booking has everything', () => {
    expect(after({ missing: [] })).not.toContain('Before it can go out')
  })
})
