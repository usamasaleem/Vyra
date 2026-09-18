import type { QueryRunner, Transactor } from '../runner.js'

/**
 * What happens after a customer says yes.
 *
 * Nothing did. `request_booking_review` refused every call it ever received —
 * "booking review is not connected yet" — so the furthest a customer saying
 * "yes, book it" could get was a handoff with no figures attached, and
 * `booking_status` read 'none' on every conversation in the database while
 * three quotes had been sent and agreed. The funnel had no bottom.
 *
 * The rule that shapes everything here is section 18.8: final booking
 * confirmation sits with refunds and payment verification as work that is not
 * an AI tool at all. So the agent may record that somebody said yes, and may
 * not say anything is booked. Every state past `requested` carries the
 * membership id of the person who put it there.
 */

export type BookingRefusal =
  | { reason: 'quote_not_found'; detail: string }
  | { reason: 'wrong_enquiry'; detail: string }
  | { reason: 'superseded'; detail: string }
  | { reason: 'expired'; detail: string }
  /** Turned down by somebody here, so not a price anyone may accept. */
  | { reason: 'not_sent'; detail: string }

export type BookingRequest = {
  bookingId: string
  quoteId: string
  /** True when this yes was already on file — they said it twice. */
  alreadyRequested: boolean
}

export type RequestBookingResult =
  | { ok: true; booking: BookingRequest }
  | { ok: false; refusal: BookingRefusal }

/**
 * Recording a customer's yes against the figures they agreed to.
 *
 * The two checks are the ones the refusing stub already documented, and they
 * guard different mistakes. Ownership stops a quote from another enquiry being
 * agreed into this one — with two rentals in a thread that is no longer
 * hypothetical. Currency stops a superseded revision being agreed at all: a
 * customer saying "yes, the 4,500 one" after the rate moved is agreeing to
 * terms that no longer exist, and recording it would put the operator in front
 * of a person holding them to a price they withdrew.
 *
 * Expiry is checked for the same reason and answered differently. A stale
 * quote is not a customer's mistake, and the answer is a fresh quote rather
 * than a refusal they have to decipher.
 */
export async function requestBooking(
  transact: Transactor,
  input: {
    operatorId: string
    conversationId: string
    enquiryId: string
    quoteId: string
    sourceMessageId?: string | null
    now?: Date
  },
): Promise<RequestBookingResult> {
  return transact(async (tx) => {
    const [quote] = await tx(
      `select q.id, q.enquiry_id, q.state::text as state, q.revision, q.valid_until,
              (select max(revision) from quotes
                where enquiry_id = q.enquiry_id and operator_id = q.operator_id) as newest
       from quotes q
       where q.id = $1 and q.operator_id = $2`,
      [input.quoteId, input.operatorId],
    )

    if (quote === undefined) {
      return {
        ok: false as const,
        refusal: {
          reason: 'quote_not_found' as const,
          detail: 'That quote does not exist for this operator.',
        },
      }
    }

    if ((quote['enquiry_id'] as string | null) !== input.enquiryId) {
      return {
        ok: false as const,
        refusal: {
          reason: 'wrong_enquiry' as const,
          detail: 'That quote belongs to a different rental in this conversation. '
            + 'Use the quote for the car they are agreeing to.',
        },
      }
    }

    const state = quote['state'] as string
    if (state === 'superseded' || Number(quote['revision']) < Number(quote['newest'])) {
      return {
        ok: false as const,
        refusal: {
          reason: 'superseded' as const,
          detail: 'Those figures have been replaced by a newer quote. Do not record a yes '
            + 'against them — show them the current price and ask again.',
        },
      }
    }

    /**
     * A draft is the ordinary case, not a mistake.
     *
     * `prepare_quote` writes a draft and hands the figures straight to the
     * model — "you may state them exactly as written" — so by the time a
     * customer says yes they have been told a price that has never been
     * through the approval screen. Refusing a draft here would have refused
     * nearly every real yes. What matters is not which state the row is in but
     * whether these are still the figures they were given, which is what the
     * revision and expiry checks above decide.
     *
     * Rejected is the exception and is somebody's decision: a quote a person
     * has turned down is not one a customer can accept.
     */
    if (state === 'rejected') {
      return {
        ok: false as const,
        refusal: {
          reason: 'not_sent' as const,
          detail: 'Somebody here has rejected that quote, so it is not a price they can '
            + 'accept. Prepare a fresh one before recording anything.',
        },
      }
    }

    const validUntil = quote['valid_until'] as Date | string | null
    const now = input.now ?? new Date()
    if (validUntil !== null && new Date(validUntil) < now) {
      return {
        ok: false as const,
        refusal: {
          reason: 'expired' as const,
          detail: 'That price has expired. Tell them you are confirming the current rate '
            + 'and get a fresh quote before recording anything.',
        },
      }
    }

    /**
     * One live request per quote, enforced by the index rather than by this
     * read. A customer says yes, then says "yes?" again ten minutes later
     * because nobody has answered — that is one booking for one person to
     * answer, not two rows racing each other.
     */
    const inserted = await tx(
      `insert into bookings
         (operator_id, conversation_id, enquiry_id, quote_id, requested_from_message_id)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning id`,
      [
        input.operatorId, input.conversationId, input.enquiryId, input.quoteId,
        input.sourceMessageId ?? null,
      ],
    )

    let bookingId = (inserted[0]?.['id'] as string) ?? null
    const alreadyRequested = bookingId === null
    if (bookingId === null) {
      const [live] = await tx(
        `select id from bookings
         where quote_id = $1 and operator_id = $2 and state in ('requested', 'confirmed')`,
        [input.quoteId, input.operatorId],
      )
      bookingId = (live?.['id'] as string) ?? null
    }

    if (bookingId === null) {
      return {
        ok: false as const,
        refusal: {
          reason: 'quote_not_found' as const,
          detail: 'That booking could not be recorded.',
        },
      }
    }

    /**
     * The conversation column that nothing had ever written. It is what the
     * inbox filters and sorts on, so a booking nobody can see in a list is a
     * booking that waits as long as the last one did.
     */
    await tx(
      `update conversations set booking_status = 'pending', updated_at = now()
       where id = $1 and operator_id = $2 and booking_status = 'none'`,
      [input.conversationId, input.operatorId],
    )

    return { ok: true as const, booking: { bookingId, quoteId: input.quoteId, alreadyRequested } }
  })
}

export type PendingBooking = {
  bookingId: string
  conversationId: string
  quoteId: string
  requestedAt: Date
  customer: string
  customerName: string | null
  vehicle: string | null
  startDate: Date | null
  endDate: Date | null
  days: number | null
  currency: string
  totalMinor: number
  depositMinor: number | null
  validUntil: Date | null
}

/**
 * Everyone waiting on an answer, longest first.
 *
 * Longest first rather than newest, because this is a queue of people who have
 * already committed and every one of them is being kept waiting by the same
 * screen. Newest-first queues starve their oldest item, which is how two
 * handoffs from the fifteenth were still open on the eighteenth.
 */
export async function listBookingRequests(
  run: QueryRunner,
  operatorId: string,
): Promise<PendingBooking[]> {
  const rows = await run(
    `select b.id, b.conversation_id, b.quote_id, b.requested_at,
            ct.channel_identifier, ct.display_name,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date, q.end_date, q.days, q.currency, q.total_minor, q.deposit_minor,
            q.valid_until
     from bookings b
     join conversations c on c.id = b.conversation_id and c.operator_id = b.operator_id
     join contacts ct on ct.id = c.contact_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.operator_id = $1 and b.state = 'requested'
     order by b.requested_at asc`,
    [operatorId],
  )

  return rows.map((r) => ({
    bookingId: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    quoteId: r['quote_id'] as string,
    requestedAt: new Date(r['requested_at'] as string),
    customer: r['channel_identifier'] as string,
    customerName: (r['display_name'] as string) ?? null,
    vehicle: (r['vehicle'] as string) ?? null,
    startDate: r['start_date'] == null ? null : new Date(r['start_date'] as string),
    endDate: r['end_date'] == null ? null : new Date(r['end_date'] as string),
    days: r['days'] == null ? null : Number(r['days']),
    currency: r['currency'] as string,
    totalMinor: Number(r['total_minor']),
    depositMinor: r['deposit_minor'] == null ? null : Number(r['deposit_minor']),
    validUntil: r['valid_until'] == null ? null : new Date(r['valid_until'] as string),
  }))
}

/**
 * A person's answer, which is the only thing that can settle this.
 *
 * Conditioned on the booking still being `requested`, so two people opening
 * the same queue cannot both decide it — the second gets `decided: false` and
 * a screen that has already moved on, rather than silently overwriting a
 * colleague's answer.
 *
 * It does not send anything. What the customer is told is a message somebody
 * wrote, through the one path that sends, signed with their name.
 */
export async function decideBooking(
  transact: Transactor,
  input: {
    operatorId: string
    bookingId: string
    membershipId: string
    decision: 'confirmed' | 'declined'
    note?: string | null
  },
): Promise<{ decided: boolean; conversationId: string | null }> {
  return transact(async (tx) => {
    const rows = await tx(
      `update bookings
       set state = $4::booking_state, decided_by_membership_id = $3, decided_at = now(),
           decision_note = $5, updated_at = now()
       where id = $1 and operator_id = $2 and state = 'requested'
       returning conversation_id`,
      [
        input.bookingId, input.operatorId, input.membershipId, input.decision,
        input.note ?? null,
      ],
    )
    const conversationId = (rows[0]?.['conversation_id'] as string) ?? null
    if (conversationId === null) return { decided: false, conversationId: null }

    /**
     * A declined booking returns the conversation to 'none' rather than
     * moving it to 'cancelled'. They asked and were told no; they have not
     * cancelled anything, and they may well take a different car.
     */
    await tx(
      `update conversations set booking_status = $3::booking_status, updated_at = now()
       where id = $1 and operator_id = $2`,
      [
        conversationId, input.operatorId,
        input.decision === 'confirmed' ? 'confirmed' : 'none',
      ],
    )

    return { decided: true, conversationId }
  })
}
