import type { QueryRunner } from '../runner.js'

/**
 * "Tell me if it frees up", kept.
 *
 * A customer asks to wait for a car that is booked on their dates; the sweep
 * tells them when nothing stands in the way any more. What frees a car does
 * not matter here — a cancellation, a booking moved to other dates, a hold
 * that ran out, a block a person cleared — because every one of them ends as
 * the calendar no longer saying no, and that is the only thing checked.
 */

export type WaitlistJoin =
  | { ok: true; added: boolean; ahead: number }
  | { ok: false; reason: 'not_booked' | 'theirs'; detail: string }

/**
 * Only for a car the calendar actually says no to. A car nobody has recorded
 * a booking for is not something to wait for — it is a question for a person,
 * and putting it on a list would promise a message the calendar can never
 * trigger.
 */
export async function joinWaitlist(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; vehicleId: string; startDate: string; endDate: string },
): Promise<WaitlistJoin> {
  const [block] = await run(
    `select (b.conversation_id is not null and b.conversation_id = $5) as theirs
     from vehicle_availability a
     left join bookings b on b.id = a.booking_id and b.operator_id = a.operator_id
     where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
       and a.start_date <= $4 and a.end_date >= $3
       and (a.expires_at is null or a.expires_at > now())
       and (a.held_for_conversation_id is null or a.held_for_conversation_id <> $5)
     order by theirs asc
     limit 1`,
    [input.operatorId, input.vehicleId, input.startDate, input.endDate, input.conversationId],
  )
  if (block === undefined) {
    return { ok: false, reason: 'not_booked', detail: 'Nothing is booked against this car for those dates, so there is nothing to wait for.' }
  }
  if (block['theirs'] === true) {
    return { ok: false, reason: 'theirs', detail: 'The booking on this car for those dates is their own.' }
  }

  const added = await run(
    `insert into waitlist_entries (operator_id, conversation_id, vehicle_id, start_date, end_date)
     values ($1, $2, $3, $4, $5)
     on conflict (conversation_id, vehicle_id, start_date, end_date) where closed_at is null do nothing
     returning id`,
    [input.operatorId, input.conversationId, input.vehicleId, input.startDate, input.endDate],
  )
  const [ahead] = await run(
    `select count(*) as n from waitlist_entries w
     where w.operator_id = $1 and w.vehicle_id = $2 and w.closed_at is null
       and w.start_date <= $5 and w.end_date >= $4
       and w.created_at < (select min(created_at) from waitlist_entries
                           where operator_id = $1 and conversation_id = $3 and vehicle_id = $2
                             and start_date = $4 and end_date = $5 and closed_at is null)`,
    [input.operatorId, input.vehicleId, input.conversationId, input.startDate, input.endDate],
  )
  return { ok: true, added: added.length > 0, ahead: Number(ahead?.['n'] ?? 0) }
}

export type WaitlistNotice = {
  entryId: string
  operatorId: string
  conversationId: string
  vehicle: string
  startDate: string
  endDate: string
  displayName: string | null
  lastCustomerMessageAt: Date | null
  lastInboundMessageId: string | null
  /** A person has the conversation: they are told, not the customer. */
  handledByAPerson: boolean
  /** The operator lets the agent settle a booking on the customer's yes. */
  mayConfirm: boolean
  holdMinutes: number | null
}

/**
 * Closes what no longer needs a message — the first day has passed, or they
 * have since booked something for those dates — and returns the rest whose
 * car is now clear, oldest first. Waking hours only, in the operator's clock:
 * a car that frees up at 2am is news at 8, not at 2.
 */
export async function dueWaitlistNotices(
  run: QueryRunner,
  options: { now?: Date; limit?: number } = {},
): Promise<WaitlistNotice[]> {
  const now = (options.now ?? new Date()).toISOString()

  await run(
    `update waitlist_entries w set closed_reason = 'expired', closed_at = now(), updated_at = now()
     from operators o
     where o.id = w.operator_id and w.closed_at is null
       and w.start_date < to_char(($1::timestamptz at time zone o.timezone)::date, 'YYYY-MM-DD')`,
    [now],
  )
  await run(
    `update waitlist_entries w set closed_reason = 'booked', closed_at = now(), updated_at = now()
     where w.closed_at is null
       and exists (
         select 1 from bookings b join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
         where b.operator_id = w.operator_id and b.conversation_id = w.conversation_id
           and b.state in ('requested', 'confirmed') and b.created_at > w.created_at
           and q.start_date::date::text <= w.end_date
           and coalesce(q.end_date, q.start_date)::date::text >= w.start_date)`,
    [],
  )

  const rows = await run(
    `select w.id, w.operator_id, w.conversation_id, w.start_date, w.end_date,
            trim(ve.make || ' ' || ve.model || ' ' || coalesce(ve.variant, '')) as vehicle,
            c.display_name, v.last_customer_message_at, v.handler_mode::text as handler_mode,
            (o.auto_confirm_bookings and o.availability_calendar_complete) as may_confirm, o.hold_minutes,
            (select m.id from messages m
              where m.conversation_id = w.conversation_id and m.operator_id = w.operator_id
                and m.direction = 'inbound'
              order by m.created_at desc limit 1) as last_inbound_id
     from waitlist_entries w
     join operators o on o.id = w.operator_id
     join vehicles ve on ve.id = w.vehicle_id and ve.operator_id = w.operator_id
     join conversations v on v.id = w.conversation_id and v.operator_id = w.operator_id
     join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
     where w.closed_at is null
       and c.opted_out_at is null
       and extract(hour from $2::timestamptz at time zone o.timezone) between 8 and 21
       and not exists (
         select 1 from vehicle_availability a
         where a.operator_id = w.operator_id and a.vehicle_id = w.vehicle_id and a.released_at is null
           and a.start_date <= w.end_date and a.end_date >= w.start_date
           and (a.expires_at is null or a.expires_at > $2::timestamptz))
     order by w.created_at
     limit $1`,
    [options.limit ?? 50, now],
  )

  return rows.map((r) => ({
    entryId: r['id'] as string,
    operatorId: r['operator_id'] as string,
    conversationId: r['conversation_id'] as string,
    vehicle: r['vehicle'] as string,
    startDate: r['start_date'] as string,
    endDate: r['end_date'] as string,
    displayName: (r['display_name'] as string) ?? null,
    lastCustomerMessageAt: r['last_customer_message_at'] == null ? null : new Date(r['last_customer_message_at'] as string),
    lastInboundMessageId: (r['last_inbound_id'] as string) ?? null,
    handledByAPerson: r['handler_mode'] !== 'ai',
    mayConfirm: r['may_confirm'] === true,
    holdMinutes: r['hold_minutes'] == null ? null : Number(r['hold_minutes']),
  }))
}

export async function closeWaitlistEntry(
  run: QueryRunner,
  input: { operatorId: string; entryId: string; reason: 'notified' | 'needs_a_person'; messageId?: string | null },
): Promise<void> {
  await run(
    `update waitlist_entries
     set closed_reason = $3, closed_at = now(), updated_at = now(),
         notified_at = case when $3 = 'notified' then now() end, notified_message_id = $4
     where id = $2 and operator_id = $1 and closed_at is null`,
    [input.operatorId, input.entryId, input.reason, input.messageId ?? null],
  )
}

/** The key the notice is queued under, so a retried sweep cannot send it twice. */
export const waitlistNoticeKey = (entryId: string): string => `waitlist:${entryId}`
