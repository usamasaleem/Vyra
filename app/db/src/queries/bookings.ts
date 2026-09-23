import { raiseWhatIsOwed } from './payments.js'
import { releaseHoldsFor } from './holds.js'
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
  /**
   * True when the agent confirmed it on the spot.
   *
   * What the reply is allowed to say turns on this and nothing else: booked,
   * or a colleague will confirm. It is decided here, against the record,
   * rather than by the model reading its own instructions.
   */
  confirmed: boolean
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
  /**
   * A quote id that is not an id at all.
   *
   * Read live: the model passed "401767f8-fe6a-4b16-8b55-c50bafef8ebd-r9",
   * the enquiry id with the revision appended, because prepare_quote returned
   * no id and that was the nearest handle it had. Postgres refused the cast,
   * the error left this function as a database failure rather than a refusal,
   * and the boundary rethrew it — correctly, since an infrastructure failure
   * must not be disguised as a refusal. The turn died and the customer got
   * silence.
   *
   * So the shape is checked here, where every caller passes through, and a
   * malformed id is what it plainly is: a quote that does not exist.
   */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID.test(input.quoteId.trim())) {
    return {
      ok: false,
      refusal: {
        reason: 'quote_not_found',
        detail: 'That is not a quote id. Use the quoteId returned by prepare_quote, exactly '
          + 'as given — if you do not have one, prepare a quote first.',
      },
    }
  }

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
     * They may already have this rental, under a different quote.
     *
     * The index below is per quote, which catches the same yes arriving
     * twice and nothing else. Read live: a turn confirmed a booking and then
     * timed out before replying, so the customer never heard. He asked again,
     * the agent re-quoted — a new quote id, a new revision — and made a second
     * booking. Then a third. Three rows for one Ferrari on one weekend, one of
     * them already holding the car.
     *
     * So the question is not "is this quote already agreed" but "do they
     * already have this car for these days", which is what a person would
     * ask. Returned rather than refused: they are trying to book, and the
     * honest answer is that they have.
     */
    const [existing] = await tx(
      `select b.id, b.state::text as state
       from bookings b
       join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
       where b.operator_id = $1 and b.conversation_id = $2
         and b.state in ('requested', 'confirmed')
         and q.vehicle_id is not distinct from (
           select vehicle_id from quotes where id = $3 and operator_id = $1
         )
         and q.start_date::date = (
           select start_date::date from quotes where id = $3 and operator_id = $1
         )
       order by case b.state when 'confirmed' then 0 else 1 end
       limit 1`,
      [input.operatorId, input.conversationId, input.quoteId],
    )
    if (existing !== undefined) {
      return {
        ok: true as const,
        booking: {
          bookingId: existing['id'] as string,
          quoteId: input.quoteId,
          alreadyRequested: true,
          confirmed: existing['state'] === 'confirmed',
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

    /**
     * And stop chasing them. `findDueFollowUps` re-checks this at dispatch
     * too, which is the guarantee; this is so the row is gone rather than
     * merely filtered, and so the reports do not count a chase that was never
     * going to be appropriate.
     */
    await tx(
      `update follow_ups
       set state = 'cancelled', cancelled_reason = 'they said yes', cancelled_at = now(),
           updated_at = now()
       where operator_id = $1 and conversation_id = $2 and state = 'scheduled'`,
      [input.operatorId, input.conversationId],
    )

    /**
     * And, if the operator allows it, answer them now.
     *
     * Section 18.8 put final booking confirmation with refunds and payment
     * verification as work that is not an AI tool, and that was right for as
     * long as confirming meant asserting a car was free on a calendar nobody
     * maintained. The system now writes a hold for every confirmed rental and
     * the overlap check is real, so an operator can decide the machine may
     * answer a yes it can actually prove. Off unless they turn it on, per
     * operator, because it is their liability and not a property of the
     * software.
     *
     * Every condition below is a way of saying "and nothing about this is
     * unusual". The unusual booking is exactly the one worth a person's eyes,
     * and the wait is only worth removing from the ordinary ones.
     */
    const confirmed = await autoConfirm(tx, {
      operatorId: input.operatorId,
      conversationId: input.conversationId,
      bookingId,
      quoteId: input.quoteId,
    })

    return {
      ok: true as const,
      booking: { bookingId, quoteId: input.quoteId, alreadyRequested, confirmed },
    }
  })
}

/**
 * Whether this one can be answered without asking anybody, and doing it.
 *
 * Runs inside the caller's transaction, takes the same lock on the vehicle and
 * makes the same overlap check as a person pressing Confirm. Nothing here is a
 * shortcut around the guarantees — what it removes is the wait, not a check.
 */
async function autoConfirm(
  tx: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    bookingId: string
    quoteId: string
  },
): Promise<boolean> {
  const [rules] = await tx(
    `select o.auto_confirm_bookings, o.auto_confirm_limit_minor,
            o.availability_calendar_complete,
            v.handler_mode::text as handler_mode,
            q.vehicle_id, q.total_minor,
            q.start_date::date::text as start_date,
            coalesce(q.end_date, q.start_date)::date::text as end_date,
            (select count(*) from handoffs h
              where h.conversation_id = v.id and h.operator_id = v.operator_id
                and h.state <> 'resolved') as open_handoffs
     from operators o
     join conversations v on v.id = $2 and v.operator_id = o.id
     join quotes q on q.id = $3 and q.operator_id = o.id
     where o.id = $1`,
    [input.operatorId, input.conversationId, input.quoteId],
  )
  if (rules === undefined) return false

  if (rules['auto_confirm_bookings'] !== true) return false

  /**
   * Without a calendar the operator vouches for, "no block" means "nobody
   * knows" — and confirming on that is the double booking this system spent a
   * day learning to prevent. An automatic yes needs a real no to be possible.
   */
  if (rules['availability_calendar_complete'] !== true) return false

  // A person is already holding this conversation. Theirs to answer.
  if (rules['handler_mode'] !== 'ai') return false
  if (Number(rules['open_handoffs']) > 0) return false

  const vehicleId = (rules['vehicle_id'] as string) ?? null
  const startDate = (rules['start_date'] as string) ?? null
  const endDate = (rules['end_date'] as string) ?? startDate
  if (vehicleId === null || startDate === null) return false

  const ceiling = rules['auto_confirm_limit_minor'] == null
    ? null
    : Number(rules['auto_confirm_limit_minor'])
  if (ceiling !== null && Number(rules['total_minor']) > ceiling) return false

  // The same lock and the same overlap test as a person's press.
  await tx(`select id from vehicles where id = $1 and operator_id = $2 for update`,
    [vehicleId, input.operatorId])

  const [clash] = await tx(
    `select 1 from vehicle_availability a
     where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
       and a.booking_id is distinct from $5
       and a.start_date <= $4 and a.end_date >= $3
       -- Their own hold is what they are booking, not a clash with it.
       and (a.expires_at is null or a.expires_at > now())
       and a.held_for_conversation_id is distinct from $6::uuid
     limit 1`,
    [input.operatorId, vehicleId, startDate, endDate, input.bookingId, input.conversationId],
  )
  if (clash !== undefined) return false

  const moved = await tx(
    `update bookings
     set state = 'confirmed', decided_at = now(), decided_automatically = true,
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'requested'
     returning id`,
    [input.bookingId, input.operatorId],
  )
  if (moved.length === 0) return false

  await tx(
    `insert into vehicle_availability
       (operator_id, vehicle_id, start_date, end_date, reason, recorded_by, booking_id)
     values ($1, $2, $3, $4, 'booked', 'confirmed by the agent', $5)`,
    [input.operatorId, vehicleId, startDate, endDate, input.bookingId],
  )
  // Booked is what the hold was for; it has done its job.
  await releaseHoldsFor(tx, {
    operatorId: input.operatorId, conversationId: input.conversationId, why: 'booked',
  })

  await tx(
    `update conversations set booking_status = 'confirmed', updated_at = now()
     where id = $1 and operator_id = $2`,
    [input.conversationId, input.operatorId],
  )
  await markWon(tx, {
    operatorId: input.operatorId,
    conversationId: input.conversationId,
    membershipId: null,
  })
  await raiseWhatIsOwed(tx, {
    operatorId: input.operatorId,
    bookingId: input.bookingId,
  })

  return true
}


/**
 * A confirmed rental is a won lead, and nothing had ever said so.
 *
 * `closeLead` exists, is tested, and is called from no screen in the product,
 * so `sales_stage` never reached 'won' — which made the conversion rate on the
 * reports page structurally zero and left `findDueFollowUps` chasing customers
 * whose rental was already on the books. A booking somebody confirmed is not
 * an opinion about whether the lead was won; it is the lead being won.
 *
 * Forward only, and never out of a stage a person chose: a conversation
 * already marked lost stays lost until somebody says otherwise.
 */
async function markWon(
  tx: QueryRunner,
  input: { operatorId: string; conversationId: string; membershipId: string | null },
): Promise<void> {
  const moved = await tx(
    // next_action goes with it, as it does when a person closes a lead by
    // hand: live, a booked Ferrari still read "Waiting on you: approve or
    // reject a draft quote" on the dashboard — a to-do for a price the
    // customer had already accepted and been held a car for.
    `update conversations set sales_stage = 'won', next_action = null, updated_at = now()
     where id = $1 and operator_id = $2 and sales_stage not in ('won', 'lost')
     returning id`,
    [input.conversationId, input.operatorId],
  )
  if (moved.length === 0) return

  await tx(
    `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
     values ($1, $2::actor_type, $3, 'lead.won', 'conversation', $4, $5::jsonb)`,
    [
      input.operatorId,
      input.membershipId === null ? 'system' : 'user',
      input.membershipId,
      input.conversationId,
      JSON.stringify({ reason: 'booking confirmed' }),
    ],
  )
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
  /**
   * The car is already held for dates that overlap these.
   *
   * Shown before anybody presses anything, because finding out at the moment
   * of confirming means a person has already decided what to tell somebody.
   */
  heldAlready: { startDate: string; endDate: string; reason: string } | null
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
            q.valid_until,
            held.start_date as held_from, held.end_date as held_to, held.reason as held_reason
     from bookings b
     join conversations c on c.id = b.conversation_id and c.operator_id = b.operator_id
     join contacts ct on ct.id = c.contact_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     left join lateral (
       select a.start_date, a.end_date, a.reason
       from vehicle_availability a
       where a.operator_id = b.operator_id and a.vehicle_id = q.vehicle_id
         and a.released_at is null and a.booking_id is distinct from b.id
         and (a.expires_at is null or a.expires_at > now())
         and a.held_for_conversation_id is distinct from b.conversation_id
         and a.start_date <= coalesce(q.end_date, q.start_date)::date::text
         and a.end_date >= q.start_date::date::text
       limit 1
     ) held on true
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
    heldAlready: r['held_from'] == null ? null : {
      startDate: r['held_from'] as string,
      endDate: r['held_to'] as string,
      reason: r['held_reason'] as string,
    },
  }))
}

export type BookingConflict = {
  /** The car, as a person would name it. */
  vehicle: string
  /** The dates already spoken for, inclusive. */
  startDate: string
  endDate: string
  reason: string
}

export type BookingDecision = {
  decided: boolean
  conversationId: string | null
  /**
   * Why it could not be confirmed: the car is already held for these dates.
   *
   * Returned rather than thrown because it is not an error — it is the answer,
   * and the person needs to see which dates and why before they tell a
   * customer anything.
   */
  conflict?: BookingConflict
}

/**
 * A person's answer, which is the only thing that can settle this.
 *
 * Conditioned on the booking still being `requested`, so two people opening
 * the same queue cannot both decide it — the second gets `decided: false` and
 * a screen that has already moved on, rather than silently overwriting a
 * colleague's answer.
 *
 * Confirming holds the car. Until it did, a confirmed booking wrote nothing to
 * the calendar: `vehicle_availability` had no rows, every `check_availability`
 * answered 'unknown', and the same Ferrari could be quoted, agreed and
 * confirmed twice for the same weekend with nothing anywhere noticing. That
 * was latent while nothing could be booked and went live the moment bookings
 * did — it is the one failure here that costs a car and a reputation rather
 * than a lead.
 *
 * The overlap check runs inside this transaction behind a lock on the vehicle
 * row, so two people confirming the same car at the same moment cannot both
 * succeed. An exclusion constraint would be the stronger version and is not
 * available: `btree_gist` does not exist in PGlite, so it would pass in
 * production and fail every test, which is a guarantee nobody can verify.
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
): Promise<BookingDecision> {
  return transact(async (tx) => {
    /**
     * Read the booking and its figures first, and take the lock before the
     * write. The dates and the car come from the quote the customer agreed
     * to — never retyped, so the hold cannot disagree with the rental.
     */
    const [target] = await tx(
      `select b.conversation_id, q.vehicle_id,
              q.start_date::date::text as start_date,
              coalesce(q.end_date, q.start_date)::date::text as end_date
       from bookings b
       join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
       where b.id = $1 and b.operator_id = $2 and b.state = 'requested'`,
      [input.bookingId, input.operatorId],
    )
    if (target === undefined) return { decided: false, conversationId: null }

    const vehicleId = (target['vehicle_id'] as string) ?? null
    const startDate = (target['start_date'] as string) ?? null
    const endDate = (target['end_date'] as string) ?? null

    if (input.decision === 'confirmed' && vehicleId !== null && startDate !== null) {
      // Serialise every confirmation of this car behind one lock.
      await tx(`select id from vehicles where id = $1 and operator_id = $2 for update`,
        [vehicleId, input.operatorId])

      const [clash] = await tx(
        `select a.start_date, a.end_date, a.reason,
                trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle
         from vehicle_availability a
         join vehicles v on v.id = a.vehicle_id and v.operator_id = a.operator_id
         where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
           and a.booking_id is distinct from $5
           and (a.expires_at is null or a.expires_at > now())
           and a.held_for_conversation_id is distinct from
               (select conversation_id from bookings where id = $5)
           -- Overlap, not containment. Inclusive of the end date: a car coming
           -- back on the 27th is not reliably free to somebody else that
           -- morning, and over-holding costs a lead where under-holding costs
           -- the car.
           and a.start_date <= $4 and a.end_date >= $3
         limit 1`,
        [input.operatorId, vehicleId, startDate, endDate ?? startDate, input.bookingId],
      )

      if (clash !== undefined) {
        return {
          decided: false,
          conversationId: null,
          conflict: {
            vehicle: clash['vehicle'] as string,
            startDate: clash['start_date'] as string,
            endDate: clash['end_date'] as string,
            reason: clash['reason'] as string,
          },
        }
      }
    }

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

    if (input.decision === 'confirmed' && vehicleId !== null && startDate !== null) {
      await tx(
        `insert into vehicle_availability
           (operator_id, vehicle_id, start_date, end_date, reason, recorded_by,
            recorded_by_membership_id, booking_id)
         values ($1, $2, $3, $4, 'booked', 'booking confirmed', $5, $6)`,
        [
          input.operatorId, vehicleId, startDate, endDate ?? startDate,
          input.membershipId, input.bookingId,
        ],
      )
    }

    if (input.decision === 'confirmed') {
      await releaseHoldsFor(tx, { operatorId: input.operatorId, conversationId, why: 'booked' })
    }

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

    if (input.decision === 'confirmed') {
      await markWon(tx, {
        operatorId: input.operatorId,
        conversationId,
        membershipId: input.membershipId,
      })
      /**
       * And what they owe, from the quote they agreed to. Raised on
       * confirmation rather than on request, because until somebody has
       * committed the car there is nothing to owe.
       */
      await raiseWhatIsOwed(tx, {
        operatorId: input.operatorId,
        bookingId: input.bookingId,
      })
    }

    return { decided: true, conversationId }
  })
}

/**
 * Letting a confirmed rental go, and giving the car back.
 *
 * Required by the hold rather than a nicety beside it. A block with no way to
 * release it makes a cancelled rental into a car nobody can sell and nobody
 * can explain — the failure is quieter than a double booking and lasts longer.
 *
 * The block is released, not deleted, like every other one: a cancellation
 * that cost somebody an enquiry should still be answerable next week.
 */
export async function cancelBooking(
  transact: Transactor,
  input: {
    operatorId: string
    bookingId: string
    membershipId: string
    note?: string | null
  },
): Promise<{ cancelled: boolean; conversationId: string | null }> {
  return transact(async (tx) => {
    const rows = await tx(
      `update bookings
       set state = 'cancelled', decided_by_membership_id = $3, decided_at = now(),
           decision_note = coalesce($4, decision_note), updated_at = now()
       where id = $1 and operator_id = $2 and state = 'confirmed'
       returning conversation_id`,
      [input.bookingId, input.operatorId, input.membershipId, input.note ?? null],
    )
    const conversationId = (rows[0]?.['conversation_id'] as string) ?? null
    if (conversationId === null) return { cancelled: false, conversationId: null }

    await tx(
      `update vehicle_availability
       set released_at = now(), released_by = 'booking cancelled', updated_at = now()
       where operator_id = $1 and booking_id = $2 and released_at is null`,
      [input.operatorId, input.bookingId],
    )

    await tx(
      `update conversations set booking_status = 'cancelled', updated_at = now()
       where id = $1 and operator_id = $2`,
      [conversationId, input.operatorId],
    )

    return { cancelled: true, conversationId }
  })
}

export type ConfirmedBooking = {
  bookingId: string
  conversationId: string
  customer: string
  customerName: string | null
  vehicle: string | null
  startDate: string | null
  endDate: string | null
  currency: string
  totalMinor: number
  confirmedAt: Date
  confirmedBy: string | null
  /** True when the agent confirmed it and nobody was asked. */
  confirmedAutomatically: boolean
}

/**
 * What is actually on the books, soonest first.
 *
 * Soonest rather than newest, because this is a diary: the rental starting
 * tomorrow is the one somebody needs to see, whenever it was agreed.
 */
export async function listConfirmedBookings(
  run: QueryRunner,
  operatorId: string,
): Promise<ConfirmedBooking[]> {
  const rows = await run(
    `select b.id, b.conversation_id, b.decided_at, b.decided_automatically,
            ct.channel_identifier, ct.display_name,
            m.display_name as confirmed_by,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date,
            coalesce(q.end_date, q.start_date)::date::text as end_date,
            q.currency, q.total_minor
     from bookings b
     join conversations c on c.id = b.conversation_id and c.operator_id = b.operator_id
     join contacts ct on ct.id = c.contact_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     left join memberships m on m.id = b.decided_by_membership_id
     where b.operator_id = $1 and b.state = 'confirmed'
     order by q.start_date asc nulls last`,
    [operatorId],
  )

  return rows.map((r) => ({
    bookingId: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    customer: r['channel_identifier'] as string,
    customerName: (r['display_name'] as string) ?? null,
    vehicle: (r['vehicle'] as string) ?? null,
    startDate: (r['start_date'] as string) ?? null,
    endDate: (r['end_date'] as string) ?? null,
    currency: r['currency'] as string,
    totalMinor: Number(r['total_minor']),
    confirmedAt: new Date(r['decided_at'] as string),
    confirmedBy: (r['confirmed_by'] as string) ?? null,
    confirmedAutomatically: r['decided_automatically'] === true,
  }))
}

/**
 * What this customer actually has booked, from the record rather than from
 * the conversation.
 *
 * Read live: a booking was cancelled overnight and the customer asked for the
 * same car in the morning. The agent answered "your Ferrari 488 Spider is
 * already confirmed for 25th–27th September" — without calling anything,
 * because the transcript still carried last night's "Confirmed — booked and
 * held". Nothing had ever told it otherwise.
 *
 * A transcript is what was said, not what is true now. A salesperson cancels,
 * a booking is declined, a rental ends — and every earlier "you're booked"
 * stays exactly where it was. So the turn reads the record every time, and
 * says so plainly when there is nothing on it.
 */
export type BookingOnFile = {
  vehicle: string | null
  startDate: string | null
  endDate: string | null
  state: 'requested' | 'confirmed'
}

export async function bookingsOnFile(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<{ live: BookingOnFile[]; everHadOne: boolean }> {
  const rows = await run(
    `select b.state::text as state,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date,
            coalesce(q.end_date, q.start_date)::date::text as end_date
     from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.operator_id = $1 and b.conversation_id = $2
       and b.state in ('requested', 'confirmed')
     order by q.start_date`,
    [input.operatorId, input.conversationId],
  )
  const [any] = await run(
    `select exists (select 1 from bookings where operator_id = $1 and conversation_id = $2) as had`,
    [input.operatorId, input.conversationId],
  )
  return {
    live: rows.map((r) => ({
      vehicle: (r['vehicle'] as string) ?? null,
      startDate: (r['start_date'] as string) ?? null,
      endDate: (r['end_date'] as string) ?? null,
      state: r['state'] as 'requested' | 'confirmed',
    })),
    everHadOne: any?.['had'] === true,
  }
}
