import type { QueryRunner } from '../runner.js'

/**
 * Asking Operations, and using the answer honestly.
 *
 * Section 6 of the MVP: "There is no automated availability lookup, and none
 * should be assumed." A person checks the real calendar. Three rules govern
 * what happens to their answer, and each is enforced here rather than trusted
 * to a caller:
 *
 *   An answer carries its source and the time it was checked. An answer without
 *   a time checked cannot be given to a customer.
 *
 *   An expired answer is rechecked before it is reused.
 *
 *   An unknown answer is communicated as unknown, with a next action. It is
 *   never softened into a maybe.
 */

export type OperationsAnswer = 'available' | 'unavailable' | 'pending_confirmation' | 'unknown'

export type CurrentAnswer = {
  requestId: string
  answer: OperationsAnswer
  note: string | null
  source: string
  checkedAt: Date
  validUntil: Date
  /** Minutes since a person actually looked. The agent relays this. */
  checkedMinutesAgo: number
}

/**
 * The only way an availability answer reaches a customer.
 *
 * `checked_at is not null` and `source is not null` are in the predicate rather
 * than checked afterwards, so there is no path where a caller forgets. The
 * database constraint makes such a row impossible to write; this makes it
 * impossible to read even if one existed.
 */
const CURRENT_ANSWER_SQL = `
  select id, answer::text as answer, answer_note, source, checked_at, answer_valid_until,
         extract(epoch from now() - checked_at)::int / 60 as checked_minutes_ago
  from operations_requests
  where operator_id = $1
    and kind = 'availability'
    and state = 'answered'
    and answer is not null
    and checked_at is not null
    and source is not null
    and answer_valid_until > now()
    and vehicle_id = $2
    -- The answer must cover the whole window asked about. An answer for the
    -- 17th says nothing about the 18th, and treating it as though it did is
    -- how a customer is promised a car for a day nobody checked.
    and start_date <= $3::date
    and end_date >= coalesce($4::date, $3::date)
  order by checked_at desc
  limit 1
`

export async function findCurrentAnswer(
  run: QueryRunner,
  input: { operatorId: string; vehicleId: string; startDate: string; endDate: string | null },
): Promise<CurrentAnswer | null> {
  const rows = await run(CURRENT_ANSWER_SQL, [
    input.operatorId, input.vehicleId, input.startDate, input.endDate,
  ])
  const row = rows[0]
  if (row === undefined) return null

  return {
    requestId: row['id'] as string,
    answer: row['answer'] as OperationsAnswer,
    note: (row['answer_note'] as string) ?? null,
    source: row['source'] as string,
    checkedAt: new Date(row['checked_at'] as string),
    validUntil: new Date(row['answer_valid_until'] as string),
    checkedMinutesAgo: Number(row['checked_minutes_ago'] ?? 0),
  }
}

/**
 * Putting a question in front of Operations.
 *
 * Deduplicated on the open question rather than on the conversation: two
 * customers asking about the same car for the same dates is one thing to check,
 * and making a person look twice is how a queue stops being read.
 */
export async function raiseOperationsRequest(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string | null
    kind: 'availability' | 'pricing'
    vehicleId: string | null
    requestedVehicle: string | null
    startDate: string | null
    endDate: string | null
  },
): Promise<{ requestId: string | null; alreadyOpen: boolean }> {
  const rows = await run(
    `with existing as (
       select id from operations_requests
       where operator_id = $1 and kind = $3::operations_request_kind and state = 'open'
         and vehicle_id is not distinct from $4::uuid
         and start_date is not distinct from $6::date
         and end_date is not distinct from $7::date
       limit 1
     ),
     created as (
       insert into operations_requests (
         operator_id, conversation_id, kind, vehicle_id, requested_vehicle, start_date, end_date
       )
       select $1, $2::uuid, $3::operations_request_kind, $4::uuid, $5, $6::date, $7::date
       where not exists (select 1 from existing)
       returning id
     )
     select coalesce((select id from created), (select id from existing)) as request_id,
            (select id from created) is null as already_open`,
    [
      input.operatorId, input.conversationId, input.kind, input.vehicleId,
      input.requestedVehicle, input.startDate, input.endDate,
    ],
  )
  const row = rows[0]
  return {
    requestId: (row?.['request_id'] as string) ?? null,
    alreadyOpen: row?.['already_open'] === true,
  }
}

/**
 * A person answering.
 *
 * `checked_at` is supplied by the caller rather than defaulted to `now()`,
 * because a person may be recording something they checked ten minutes ago and
 * the difference matters to the customer being told. The validity window is
 * measured from that moment, not from when the form was submitted.
 */
export async function answerOperationsRequest(
  run: QueryRunner,
  input: {
    requestId: string
    operatorId: string
    membershipId: string
    answer: OperationsAnswer
    source: string
    note?: string | null
    checkedAt?: Date
  },
): Promise<{ answered: boolean; conversationId: string | null; validUntil: Date | null }> {
  const rows = await run(
    `with answered as (
       update operations_requests r
       set state = 'answered',
           answer = $4::operations_answer,
           answer_note = $6,
           source = $5,
           checked_at = $7::timestamptz,
           answered_by_membership_id = $3,
           answer_valid_until = $7::timestamptz + make_interval(mins => o.answer_valid_minutes),
           updated_at = now()
       from operators o
       where r.id = $1 and r.operator_id = $2 and o.id = r.operator_id
         and r.state = 'open'
       returning r.id, r.operator_id, r.conversation_id, r.answer_valid_until
     ),
     audited as (
       insert into audit_events (
         operator_id, actor_type, actor_id, action, subject_type, subject_id, data
       )
       select a.operator_id, 'user', $3, 'operations.answered', 'operations_request', a.id,
              jsonb_build_object('answer', $4::text, 'source', $5, 'checked_at', $7::timestamptz)
       from answered a
       returning id
     )
     select (select id from answered) as id,
            (select conversation_id from answered) as conversation_id,
            (select answer_valid_until from answered) as valid_until`,
    [
      input.requestId, input.operatorId, input.membershipId, input.answer,
      input.source, input.note ?? null, (input.checkedAt ?? new Date()).toISOString(),
    ],
  )
  const row = rows[0]
  const answered = row?.['id'] != null
  return {
    answered,
    /** So the person who answered can tell the customer in the same action. */
    conversationId: (row?.['conversation_id'] as string) ?? null,
    validUntil: row?.['valid_until'] == null ? null : new Date(row['valid_until'] as string),
  }
}

export type OperationsQueueItem = {
  id: string
  kind: string
  conversationId: string | null
  vehicleId: string | null
  requestedVehicle: string | null
  vehicleLabel: string | null
  startDate: string | null
  endDate: string | null
  waitingMinutes: number
  customerName: string | null
  whatsappNumber: string | null
}

/**
 * A `date` column as YYYY-MM-DD, whatever the driver hands back.
 *
 * PGlite returns a Date object and postgres.js may return a string, so a type
 * saying `string` was true in production and false in tests — or the other way
 * round, which is worse, because the tests would agree with themselves. Coerced
 * once here so the shape is the same everywhere.
 */
function asCivilDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

export async function listOpenOperationsRequests(
  run: QueryRunner,
  operatorId: string,
  limit = 50,
): Promise<OperationsQueueItem[]> {
  const rows = await run(
    `select r.id, r.kind::text as kind, r.conversation_id, r.vehicle_id, r.requested_vehicle,
            r.start_date, r.end_date,
            extract(epoch from now() - r.created_at)::int / 60 as waiting_minutes,
            case when v.id is null then null
                 else v.make || ' ' || v.model || coalesce(' ' || v.variant, '') ||
                      ' · ' || v.colour end as vehicle_label,
            c.display_name, c.channel_identifier
     from operations_requests r
     left join vehicles v on v.id = r.vehicle_id and v.operator_id = r.operator_id
     left join conversations conv on conv.id = r.conversation_id and conv.operator_id = r.operator_id
     left join contacts c on c.id = conv.contact_id and c.operator_id = r.operator_id
     where r.operator_id = $1 and r.state = 'open'
     order by r.created_at
     limit $2`,
    [operatorId, limit],
  )

  return rows.map((r) => ({
    id: r['id'] as string,
    kind: r['kind'] as string,
    conversationId: (r['conversation_id'] as string) ?? null,
    vehicleId: (r['vehicle_id'] as string) ?? null,
    requestedVehicle: (r['requested_vehicle'] as string) ?? null,
    vehicleLabel: (r['vehicle_label'] as string) ?? null,
    startDate: asCivilDate(r['start_date']),
    endDate: asCivilDate(r['end_date']),
    waitingMinutes: Number(r['waiting_minutes'] ?? 0),
    customerName: (r['display_name'] as string) ?? null,
    whatsappNumber: (r['channel_identifier'] as string) ?? null,
  }))
}

/**
 * Dropping a request nobody needs to answer.
 *
 * `cancelled` has been in `operations_request_state` since the table existed
 * and nothing ever wrote it, so a request raised about a car the customer then
 * changed their mind about stayed open for good. Six of them had to be closed
 * by hand in the database, which is the plainest statement that the control
 * was missing.
 */
export async function dismissOperationsRequest(
  run: QueryRunner,
  input: { operatorId: string; requestId: string; membershipId: string; reason: string },
): Promise<{ dismissed: boolean }> {
  const rows = await run(
    `update operations_requests
     set state = 'cancelled', answer_note = $4, answered_by_membership_id = $3,
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'open'
     returning id`,
    [input.requestId, input.operatorId, input.membershipId, input.reason],
  )
  return { dismissed: rows.length > 0 }
}
