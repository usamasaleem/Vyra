import { calculateDraftQuote } from './quotes.js'
import type { QueryRunner, Transactor } from '../runner.js'

/**
 * Keeping the car a bit longer.
 *
 * The highest-frequency thing a rental customer asks for after they have the
 * keys, and until now the only answer was a person. It is also the cheapest
 * thing to build correctly here, because an extension is not a new concept:
 * it is the same car for the days after the ones already held.
 *
 * So it is a booking. A quote for the extra days, a booking row against it,
 * the same overlap check behind the same lock on the vehicle, the same rule
 * about whether the agent may confirm it, the same queue when it may not, and
 * the same cancellation giving the days back. Nothing here is a parallel path
 * that would need fixing twice.
 *
 * Adjacent rather than overlapping, which is what makes that work. A hold runs
 * inclusive of its end date, so a rental held to the 27th and extended to the
 * 29th produces a second hold over the 28th and 29th — no overlap with its own
 * original, and a real overlap with anybody else's booking in between, which
 * is exactly the answer wanted.
 */

export type ExtensionRefusal =
  | { reason: 'no_booking'; detail: string }
  | { reason: 'not_confirmed'; detail: string }
  | { reason: 'not_later'; detail: string }
  | { reason: 'taken'; detail: string; until: string }
  | { reason: 'cannot_price'; detail: string }

export type Extension = {
  bookingId: string
  quoteId: string
  /** Inclusive, and the day after the rental they already have. */
  fromDate: string
  toDate: string
  extraDays: number
  currency: string
  extraMinor: number
  /** True when the agent was allowed to settle it on the spot. */
  confirmed: boolean
}

export type ExtensionResult =
  | { ok: true; extension: Extension }
  | { ok: false; refusal: ExtensionRefusal }

const DAY = 86_400_000
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`)
const asIso = (at: Date) => at.toISOString().slice(0, 10)

/**
 * The rental this conversation could extend.
 *
 * The newest confirmed one, because a customer with two cars asking to keep
 * "it" longer means the one they are talking about, and the newest is the
 * best guess a query can make. The agent names the car back either way.
 */
export async function extendableBooking(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<{ bookingId: string; vehicle: string | null; endDate: string } | null> {
  const [row] = await run(
    `select b.id,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            coalesce(q.end_date, q.start_date)::date::text as end_date
     from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.operator_id = $1 and b.conversation_id = $2 and b.state = 'confirmed'
     order by coalesce(q.end_date, q.start_date) desc
     limit 1`,
    [input.operatorId, input.conversationId],
  )
  if (row === undefined) return null
  return {
    bookingId: row['id'] as string,
    vehicle: (row['vehicle'] as string) ?? null,
    endDate: row['end_date'] as string,
  }
}

export async function extendBooking(
  transact: Transactor,
  input: {
    operatorId: string
    bookingId: string
    /** The new last day of the rental, inclusive. */
    newEndDate: string
    /** Null when the agent is doing it rather than a person. */
    membershipId?: string | null
    now?: Date
  },
): Promise<ExtensionResult> {
  return transact(async (tx) => {
    const [current] = await tx(
      `select b.conversation_id, b.enquiry_id, b.state::text as state,
              q.vehicle_id, q.currency,
              coalesce(q.end_date, q.start_date)::date::text as end_date
       from bookings b
       join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
       where b.id = $1 and b.operator_id = $2`,
      [input.bookingId, input.operatorId],
    )
    if (current === undefined) {
      return {
        ok: false as const,
        refusal: { reason: 'no_booking' as const, detail: 'There is no booking to extend.' },
      }
    }
    if (current['state'] !== 'confirmed') {
      return {
        ok: false as const,
        refusal: {
          reason: 'not_confirmed' as const,
          detail: 'That rental is not confirmed yet, so there is nothing to extend. Settle the '
            + 'booking first.',
        },
      }
    }

    const vehicleId = current['vehicle_id'] as string | null
    const held = current['end_date'] as string

    /**
     * Two conventions meet here, and getting it wrong costs a day's rental
     * every time.
     *
     * A hold is inclusive of its end date — "a car booked the 20th to the 23rd
     * is out on both" — while a quote treats the end as the day it comes back,
     * so the 25th to the 27th is two rental days. Both are right for what they
     * describe and they do not line up.
     *
     * So the extra days are priced from the day the rental currently ends,
     * because that is the day they stop returning it and start keeping it. The
     * extra hold starts the day after, because the original already covers the
     * return day. A rental to the 27th extended to the 29th is two more days
     * of rental and two more days of hold, the 28th and the 29th.
     */
    const pricedFrom = held
    const holdFrom = asIso(new Date(asDate(held).getTime() + DAY))

    if (vehicleId === null || input.newEndDate <= held) {
      return {
        ok: false as const,
        refusal: {
          reason: 'not_later' as const,
          detail: `That rental already runs to ${held}. To finish earlier, or to change the `
            + 'dates rather than add to them, a colleague has to do it.',
        },
      }
    }

    /**
     * The same lock and the same overlap test a first booking gets. Its own
     * hold is excluded by dates rather than by id: the extension starts the
     * day after the original ends, so they cannot overlap.
     */
    await tx(`select id from vehicles where id = $1 and operator_id = $2 for update`,
      [vehicleId, input.operatorId])

    const [clash] = await tx(
      `select a.end_date, a.reason from vehicle_availability a
       where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
         and a.start_date <= $4 and a.end_date >= $3
       order by a.start_date
       limit 1`,
      [input.operatorId, vehicleId, holdFrom, input.newEndDate],
    )
    if (clash !== undefined) {
      return {
        ok: false as const,
        refusal: {
          reason: 'taken' as const,
          until: clash['end_date'] as string,
          detail: 'That car is already promised to somebody else for part of those days. Offer '
            + 'them a shorter extension up to the day before, or another car.',
        },
      }
    }

    /**
     * Priced as its own rental over the extra days, so the operator's own
     * tiers apply: five days added to a two-day rental is a week's rate if
     * that is what their table says, not five times the daily one.
     */
    const priced = await calculateDraftQuote(tx, {
      operatorId: input.operatorId,
      conversationId: current['conversation_id'] as string,
      enquiryId: (current['enquiry_id'] as string) ?? null,
      vehicleId,
      startDate: pricedFrom,
      endDate: input.newEndDate,
    })
    if (!priced.ok) {
      return {
        ok: false as const,
        refusal: {
          reason: 'cannot_price' as const,
          detail: priced.refusal.detail,
        },
      }
    }

    const quoteId = priced.quote.quoteId
    const [created] = await tx(
      `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state)
       values ($1, $2, $3, $4, 'requested')
       returning id`,
      [
        input.operatorId, current['conversation_id'],
        (current['enquiry_id'] as string) ?? null, quoteId,
      ],
    )
    const bookingId = created!['id'] as string

    const confirmed = await settleExtension(tx, {
      operatorId: input.operatorId,
      conversationId: current['conversation_id'] as string,
      bookingId,
      vehicleId,
      from: holdFrom,
      to: input.newEndDate,
      totalMinor: priced.quote.totalMinor,
      membershipId: input.membershipId ?? null,
    })

    return {
      ok: true as const,
      extension: {
        bookingId,
        quoteId,
        fromDate: holdFrom,
        toDate: input.newEndDate,
        extraDays: priced.quote.days,
        currency: priced.quote.currency,
        extraMinor: priced.quote.totalMinor,
        confirmed,
      },
    }
  })
}

/**
 * Whether this one can be settled without asking anybody.
 *
 * The same rules a first booking answers to, deliberately: an operator who has
 * decided the agent may confirm a rental has decided the harder case already,
 * and a different answer for extensions would be a second policy nobody set.
 * The overlap test has already run above, so this is the rest of "nothing
 * about this is unusual".
 */
async function settleExtension(
  tx: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    bookingId: string
    vehicleId: string
    from: string
    to: string
    totalMinor: number
    membershipId: string | null
  },
): Promise<boolean> {
  const [rules] = await tx(
    `select o.auto_confirm_bookings, o.auto_confirm_limit_minor,
            o.availability_calendar_complete,
            v.handler_mode::text as handler_mode,
            (select count(*) from handoffs h
              where h.conversation_id = v.id and h.operator_id = v.operator_id
                and h.state <> 'resolved') as open_handoffs
     from operators o
     join conversations v on v.id = $2 and v.operator_id = o.id
     where o.id = $1`,
    [input.operatorId, input.conversationId],
  )
  if (rules === undefined) return false

  const byAPerson = input.membershipId !== null
  if (!byAPerson) {
    if (rules['auto_confirm_bookings'] !== true) return false
    if (rules['availability_calendar_complete'] !== true) return false
    if (rules['handler_mode'] !== 'ai') return false
    if (Number(rules['open_handoffs']) > 0) return false
    const ceiling = rules['auto_confirm_limit_minor'] == null
      ? null
      : Number(rules['auto_confirm_limit_minor'])
    if (ceiling !== null && input.totalMinor > ceiling) return false
  }

  await tx(
    `update bookings
     set state = 'confirmed', decided_at = now(), decided_by_membership_id = $2,
         decided_automatically = $3, updated_at = now()
     where id = $1 and state = 'requested'`,
    [input.bookingId, input.membershipId, !byAPerson],
  )

  await tx(
    `insert into vehicle_availability
       (operator_id, vehicle_id, start_date, end_date, reason, recorded_by,
        recorded_by_membership_id, booking_id)
     values ($1, $2, $3, $4, 'booked', $5, $6, $7)`,
    [
      input.operatorId, input.vehicleId, input.from, input.to,
      byAPerson ? 'extension confirmed' : 'extension confirmed by the agent',
      input.membershipId, input.bookingId,
    ],
  )

  return true
}
