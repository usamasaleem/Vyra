import { calculateDraftQuote } from './quotes.js'
import type { QueryRunner, Transactor } from '../runner.js'

/**
 * A customer cancelling, or moving their dates, without waiting on anybody.
 *
 * Both used to be a person's: the agent could book and extend but not undo or
 * move, so "can we do next weekend instead?" and "I need to cancel" each
 * became a task while the customer waited. The rules that make them safe are
 * here rather than in the prompt — the car must be free for the new dates, the
 * price is the operator's own, and money already paid is never moved by the
 * agent: a refund or a difference owed back goes to a person.
 */

export type ChangeableBooking = {
  bookingId: string
  state: 'requested' | 'confirmed'
  vehicleId: string | null
  vehicle: string | null
  startDate: string
  endDate: string
  days: number
  currency: string
  totalMinor: number
  depositMinor: number | null
  /** Paid so far, by kind: what a cancellation would have to refund. */
  paidMinor: number
  /** Whole hours from now to the first day, at the start of that day in the operator's timezone. */
  hoursToHandover: number
  started: boolean
  /** Extensions are bookings of their own; a rental with one has begun and is not moved. */
  extensions: number
}

export async function changeableBooking(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; now?: Date },
): Promise<ChangeableBooking | null> {
  const now = input.now ?? new Date()
  const [row] = await run(
    `select b.id, b.state::text as state, q.vehicle_id,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date, coalesce(q.end_date, q.start_date)::date::text as end_date,
            q.days, q.currency, q.total_minor, q.deposit_minor,
            extract(epoch from ((q.start_date::date::timestamp + coalesce(b.delivery_time, '00:00')::time)
                                 at time zone o.timezone) - $3::timestamptz) / 3600 as hours,
            (select coalesce(sum(p.amount_minor), 0) from payments p
              where p.booking_id = b.id and p.operator_id = b.operator_id and p.state = 'paid') as paid,
            (select count(*) from bookings x
              where x.conversation_id = b.conversation_id and x.operator_id = b.operator_id
                and x.id <> b.id and x.state = 'confirmed'
                and x.created_at > b.created_at) as extensions
     from bookings b
     join operators o on o.id = b.operator_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.operator_id = $1 and b.conversation_id = $2 and b.state in ('requested', 'confirmed')
     order by b.created_at asc
     limit 1`,
    [input.operatorId, input.conversationId, now.toISOString()],
  )
  if (row === undefined) return null
  const hours = Math.floor(Number(row['hours']))
  return {
    bookingId: row['id'] as string,
    state: row['state'] as 'requested' | 'confirmed',
    vehicleId: (row['vehicle_id'] as string) ?? null,
    vehicle: (row['vehicle'] as string) ?? null,
    startDate: row['start_date'] as string,
    endDate: row['end_date'] as string,
    days: Number(row['days'] ?? 1),
    currency: row['currency'] as string,
    totalMinor: Number(row['total_minor']),
    depositMinor: row['deposit_minor'] == null ? null : Number(row['deposit_minor']),
    paidMinor: Number(row['paid'] ?? 0),
    hoursToHandover: hours,
    started: hours <= 0,
    extensions: Number(row['extensions'] ?? 0),
  }
}

/**
 * Cancelled at the customer's word: the booking and any extension of it, the
 * car's dates released, anything still owed withdrawn. Anything already paid
 * stays paid until a person refunds it under the policy — the agent says what
 * the policy says, and never moves money.
 */
export async function cancelForCustomer(
  transact: Transactor,
  input: { operatorId: string; conversationId: string; now?: Date },
): Promise<{ cancelled: number; paidMinor: number; currency: string | null }> {
  return transact(async (tx) => {
    const rows = await tx(
      `update bookings set state = 'cancelled', decision_note = 'Cancelled by the customer on WhatsApp',
                           updated_at = now()
       where operator_id = $1 and conversation_id = $2 and state in ('requested', 'confirmed')
       returning id`,
      [input.operatorId, input.conversationId],
    )
    const ids = rows.map((r) => r['id'] as string)
    if (ids.length === 0) return { cancelled: 0, paidMinor: 0, currency: null }

    await tx(
      `update vehicle_availability set released_at = now(), released_by = 'cancelled by the customer', updated_at = now()
       where operator_id = $1 and released_at is null
         and (booking_id = any($2::uuid[]) or held_for_conversation_id = $3)`,
      [input.operatorId, ids, input.conversationId],
    )
    await tx(
      `update payments set state = 'cancelled', updated_at = now()
       where operator_id = $1 and booking_id = any($2::uuid[]) and state = 'due'`,
      [input.operatorId, ids],
    )
    const [paid] = await tx(
      `select coalesce(sum(amount_minor), 0) as paid, max(currency) as currency from payments
       where operator_id = $1 and booking_id = any($2::uuid[]) and state = 'paid'`,
      [input.operatorId, ids],
    )
    await tx(
      `update conversations set booking_status = 'cancelled', updated_at = now()
       where id = $1 and operator_id = $2`,
      [input.conversationId, input.operatorId],
    )
    await tx(
      `insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
       select $1, 'ai', 'booking.cancelled_by_customer', 'booking', id, '{}'::jsonb from bookings where id = any($2::uuid[])`,
      [input.operatorId, ids],
    )
    return { cancelled: ids.length, paidMinor: Number(paid?.['paid'] ?? 0), currency: (paid?.['currency'] as string) ?? null }
  })
}

export type DateChange =
  | {
      ok: true
      quoteId: string
      days: number
      totalMinor: number
      /** New total less the old one: positive is more to pay. */
      differenceMinor: number
      currency: string
      /** Rental already paid and the new total is lower: a person refunds the difference. */
      refundMinor: number
      applied: boolean
    }
  | { ok: false; reason: 'not_found' | 'started' | 'extended' | 'taken' | 'cannot_price' | 'over_ceiling' | 'same'; detail: string }

/**
 * The same car, new dates. Priced at the operator's rates, checked against
 * the calendar, and applied only when `apply` is set — the tool asks first and
 * applies on the customer's yes.
 */
export async function moveBookingDates(
  transact: Transactor,
  input: {
    operatorId: string
    conversationId: string
    enquiryId: string | null
    newStartDate: string
    newEndDate: string
    apply: boolean
    now?: Date
  },
): Promise<DateChange> {
  return transact(async (tx) => {
    const current = await changeableBooking(tx, { operatorId: input.operatorId, conversationId: input.conversationId, now: input.now })
    if (current === null || current.vehicleId === null) {
      return { ok: false as const, reason: 'not_found' as const, detail: 'There is no booking here to move.' }
    }
    if (current.started) {
      return { ok: false as const, reason: 'started' as const, detail: 'The rental has already begun, so its dates cannot be moved. To keep the car longer, extend it instead.' }
    }
    if (current.extensions > 0) {
      return { ok: false as const, reason: 'extended' as const, detail: 'This rental has been extended, so a colleague has to move it.' }
    }
    if (input.newStartDate === current.startDate && input.newEndDate === current.endDate) {
      return { ok: false as const, reason: 'same' as const, detail: 'Those are already the dates on the booking.' }
    }

    await tx(`select id from vehicles where id = $1 and operator_id = $2 for update`, [current.vehicleId, input.operatorId])
    const [clash] = await tx(
      `select a.start_date, a.end_date from vehicle_availability a
       where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
         and a.start_date <= $4 and a.end_date >= $3
         and (a.expires_at is null or a.expires_at > now())
         and a.booking_id is distinct from $5::uuid
         and a.held_for_conversation_id is distinct from $6::uuid
       limit 1`,
      [input.operatorId, current.vehicleId, input.newStartDate, input.newEndDate, current.bookingId, input.conversationId],
    )
    if (clash !== undefined) {
      return {
        ok: false as const, reason: 'taken' as const,
        detail: `The ${current.vehicle ?? 'car'} is already booked from ${clash['start_date'] as string} to ${clash['end_date'] as string}, so it cannot move to those dates. Offer other dates, or another car.`,
      }
    }

    const priced = await calculateDraftQuote(tx, {
      operatorId: input.operatorId, conversationId: input.conversationId, enquiryId: input.enquiryId,
      vehicleId: current.vehicleId, startDate: input.newStartDate, endDate: input.newEndDate,
    })
    if (!priced.ok) return { ok: false as const, reason: 'cannot_price' as const, detail: priced.refusal.detail }
    const quote = priced.quote

    const [rules] = await tx(
      `select auto_confirm_limit_minor, auto_confirm_max_days from operators where id = $1`, [input.operatorId])
    const limit = rules?.['auto_confirm_limit_minor'] == null ? null : Number(rules['auto_confirm_limit_minor'])
    const maxDays = rules?.['auto_confirm_max_days'] == null ? null : Number(rules['auto_confirm_max_days'])
    if ((limit !== null && quote.totalMinor > limit) || (maxDays !== null && quote.days > maxDays)) {
      return {
        ok: false as const, reason: 'over_ceiling' as const,
        detail: 'The new dates take the booking over what you may settle by yourself. Say a colleague will confirm the change.',
      }
    }

    const [rental] = await tx(
      `select id, state::text as state, amount_minor from payments
       where operator_id = $1 and booking_id = $2 and kind = 'rental' and state in ('due', 'paid')`,
      [input.operatorId, current.bookingId],
    )
    const difference = quote.totalMinor - current.totalMinor
    const refund = rental?.['state'] === 'paid' && difference < 0 ? -difference : 0

    if (input.apply) {
      await tx(`update bookings set quote_id = $3, updated_at = now() where id = $1 and operator_id = $2`,
        [current.bookingId, input.operatorId, quote.quoteId])
      await tx(
        `update vehicle_availability set start_date = $3, end_date = $4, updated_at = now()
         where operator_id = $1 and booking_id = $2 and released_at is null`,
        [input.operatorId, current.bookingId, input.newStartDate, input.newEndDate],
      )
      if (rental?.['state'] === 'due') {
        await tx(`update payments set amount_minor = $2, updated_at = now() where id = $1`, [rental['id'], quote.totalMinor])
      } else if (rental?.['state'] === 'paid' && difference > 0) {
        await tx(
          `insert into payments (operator_id, booking_id, conversation_id, kind, state, amount_minor, currency, label)
           values ($1, $2, $3, 'add_on', 'due', $4, $5, 'Date change')`,
          [input.operatorId, current.bookingId, input.conversationId, difference, quote.currency],
        )
      }
      if (quote.depositMinor !== null) {
        await tx(
          `update payments set amount_minor = $3, updated_at = now()
           where operator_id = $1 and booking_id = $2 and kind = 'deposit' and state = 'due'`,
          [input.operatorId, current.bookingId, quote.depositMinor])
      }
      await tx(
        `insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
         values ($1, 'ai', 'booking.dates_changed', 'booking', $2, $3::jsonb)`,
        [input.operatorId, current.bookingId, JSON.stringify({
          from: [current.startDate, current.endDate], to: [input.newStartDate, input.newEndDate],
          totalMinor: quote.totalMinor, previousTotalMinor: current.totalMinor,
        })],
      )
    }

    return {
      ok: true as const,
      quoteId: quote.quoteId,
      days: quote.days,
      totalMinor: quote.totalMinor,
      differenceMinor: difference,
      currency: quote.currency,
      refundMinor: refund,
      applied: input.apply,
    }
  })
}
