import type { QueryRunner } from '../runner.js'

/**
 * The two messages a rental sends on a calendar rather than in reply.
 *
 * The day before the car goes out, and the day before it comes back. Both are
 * the operator's words, published under Messages, with the booking's facts
 * rendered underneath — the same split as a quote: the voice is theirs, the
 * figures are the record's.
 *
 * Found here, sent by the worker's sweep. Daytime only, in the operator's own
 * clock: a reminder at 3am about a car at 10 is not a courtesy.
 */
export type ReminderKind = 'handover-reminder' | 'return-reminder'

export type DueReminder = {
  kind: ReminderKind
  bookingId: string
  operatorId: string
  conversationId: string
  /** Part of the idempotency key: a booking whose dates move is reminded again. */
  forDate: string
  lastCustomerMessageAt: Date | null
  lastInboundMessageId: string | null
}

export const reminderKey = (r: { kind: ReminderKind; bookingId: string; forDate: string }): string =>
  `${r.kind}:${r.bookingId}:${r.forDate}`

const DUE = `
  with local as (
    select o.id as operator_id,
           ($2::timestamptz at time zone o.timezone)::date as today,
           extract(hour from $2::timestamptz at time zone o.timezone) as hour
    from operators o
  ),
  candidates as (
    -- The day before it goes out. Not for a booking made in the last twelve
    -- hours: they were sent the whole of it when it was completed.
    select 'handover-reminder' as kind, b.id as booking_id, b.operator_id, b.conversation_id,
           q.start_date::date as for_date
    from bookings b
    join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
    join local l on l.operator_id = b.operator_id
    where b.state = 'confirmed' and b.returned_at is null
      and q.start_date::date = l.today + 1
      and b.decided_at < $2::timestamptz - interval '12 hours'
      and l.hour between 10 and 19
    union all
    -- The day before it comes back; for a one-day rental, the morning of.
    -- Not once they have already said when.
    select 'return-reminder', b.id, b.operator_id, b.conversation_id,
           coalesce(q.end_date, q.start_date)::date
    from bookings b
    join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
    join local l on l.operator_id = b.operator_id
    where b.state = 'confirmed' and b.returned_at is null and b.return_time is null
      and greatest(coalesce(q.end_date, q.start_date)::date - 1, q.start_date::date + 1)
          = l.today
      and l.hour between 10 and 19
  )
  select c.kind, c.booking_id, c.operator_id, c.conversation_id, c.for_date::text as for_date,
         v.last_customer_message_at,
         (select m.id from messages m
           where m.conversation_id = c.conversation_id and m.direction = 'inbound'
           order by m.created_at desc limit 1) as last_inbound_id
  from candidates c
  join conversations v on v.id = c.conversation_id and v.operator_id = c.operator_id
  join contacts ct on ct.id = v.contact_id
  where ct.opted_out_at is null
    and not exists (
      select 1 from messages m
      where m.conversation_id = c.conversation_id
        and m.idempotency_key = c.kind || ':' || c.booking_id || ':' || c.for_date::text)
  limit $1
`

export async function dueReminders(
  run: QueryRunner,
  options: { now?: Date; limit?: number } = {},
): Promise<DueReminder[]> {
  const rows = await run(DUE, [options.limit ?? 50, (options.now ?? new Date()).toISOString()])
  return rows.map((r) => ({
    kind: r['kind'] as ReminderKind,
    bookingId: r['booking_id'] as string,
    operatorId: r['operator_id'] as string,
    conversationId: r['conversation_id'] as string,
    forDate: r['for_date'] as string,
    lastCustomerMessageAt: r['last_customer_message_at'] == null
      ? null : new Date(r['last_customer_message_at'] as string),
    lastInboundMessageId: (r['last_inbound_id'] as string) ?? null,
  }))
}

/** Whether a reminder has gone, for the handover board. */
export async function remindersSent(
  run: QueryRunner,
  input: { operatorId: string; bookingIds: readonly string[] },
): Promise<Set<string>> {
  if (input.bookingIds.length === 0) return new Set()
  const rows = await run(
    `select idempotency_key from messages
     where operator_id = $1 and direction = 'outbound'
       and (idempotency_key like 'handover-reminder:%' or idempotency_key like 'return-reminder:%'
            or idempotency_key like 'thank-you:%')
       and split_part(idempotency_key, ':', 2) = any($2::text[])`,
    [input.operatorId, [...input.bookingIds]],
  )
  // "handover-reminder:<booking>" — the date is dropped; the board asks per booking.
  return new Set(rows.map((r) => {
    const [kind, booking] = String(r['idempotency_key']).split(':')
    return `${kind}:${booking}`
  }))
}
