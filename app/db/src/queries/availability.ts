import type { QueryRunner } from '../runner.js'

/**
 * The calendar half of availability.
 *
 * The other half already existed and is reactive: the agent raises a question,
 * a person answers, the answer is good for a window. It works and it costs a
 * person every time — one answer has been given in the pilot, against dozens of
 * dated enquiries.
 *
 * A block recorded once answers every enquiry that touches it. What it cannot
 * do is answer the opposite: a car with no block against it is a car nobody has
 * recorded a booking for, which is a fact about the calendar rather than about
 * the car. Only an operator who actually keeps the calendar current can turn
 * that into "free", and they say so themselves — see
 * availability_calendar_complete.
 */
export type AvailabilityBlock = {
  id: string
  vehicleId: string
  vehicleLabel: string
  startDate: string
  endDate: string
  reason: string
  note: string | null
  recordedBy: string
  releasedAt: Date | null
}

/**
 * What the calendar can say about one car over one range.
 *
 * 'booked'   — a block overlaps. Authoritative, and a no.
 * 'free'     — no block, and this operator keeps the calendar complete.
 * 'unknown'  — no block, and nobody has claimed the calendar is complete.
 */
export type CalendarVerdict =
  | { state: 'booked'; until: string; reason: string }
  | { state: 'free' }
  | { state: 'unknown' }

export async function checkCalendar(
  run: QueryRunner,
  input: { operatorId: string; vehicleId: string; startDate: string; endDate: string | null },
): Promise<CalendarVerdict> {
  // A single day is a range of one; an open-ended enquiry is treated as that
  // day only, because the customer has not said otherwise.
  const end = input.endDate ?? input.startDate

  const rows = await run(
    `select end_date, reason from vehicle_availability
     where operator_id = $1 and vehicle_id = $2 and released_at is null
       -- Overlap, not containment: a booking that covers any part of the
       -- requested range means the car is not free for the whole of it.
       and start_date <= $4 and end_date >= $3
     order by end_date desc
     limit 1`,
    [input.operatorId, input.vehicleId, input.startDate, end],
  )

  const block = rows[0]
  if (block !== undefined) {
    return {
      state: 'booked',
      until: block['end_date'] as string,
      reason: block['reason'] as string,
    }
  }

  const [operator] = await run(
    `select availability_calendar_complete from operators where id = $1`,
    [input.operatorId],
  )

  /**
   * The line this whole file exists to draw. An empty calendar is silence, and
   * silence is only an answer when somebody has said it is.
   */
  return operator?.['availability_calendar_complete'] === true
    ? { state: 'free' }
    : { state: 'unknown' }
}

export async function listAvailability(
  run: QueryRunner,
  operatorId: string,
  options: { includeReleased?: boolean } = {},
): Promise<AvailabilityBlock[]> {
  const rows = await run(
    `select a.id, a.vehicle_id, a.start_date, a.end_date, a.reason, a.note,
            a.recorded_by, a.released_at,
            v.make || ' ' || v.model || coalesce(' ' || v.variant, '') as vehicle_label
     from vehicle_availability a
     join vehicles v on v.id = a.vehicle_id and v.operator_id = a.operator_id
     where a.operator_id = $1
       and ($2::boolean is true or a.released_at is null)
       -- Yesterday's bookings are history, not a calendar.
       and ($2::boolean is true or a.end_date >= to_char(now(), 'YYYY-MM-DD'))
     order by a.start_date, v.make`,
    [operatorId, options.includeReleased ?? false],
  )

  return rows.map((r) => ({
    id: r['id'] as string,
    vehicleId: r['vehicle_id'] as string,
    vehicleLabel: r['vehicle_label'] as string,
    startDate: r['start_date'] as string,
    endDate: r['end_date'] as string,
    reason: r['reason'] as string,
    note: (r['note'] as string) ?? null,
    recordedBy: r['recorded_by'] as string,
    releasedAt: r['released_at'] == null ? null : new Date(r['released_at'] as string),
  }))
}

export async function recordUnavailable(
  run: QueryRunner,
  input: {
    operatorId: string
    vehicleId: string
    startDate: string
    endDate: string
    reason: string
    note?: string | null
    recordedBy: string
    recordedByMembershipId?: string | null
  },
): Promise<{ id: string | null }> {
  const rows = await run(
    `insert into vehicle_availability
       (operator_id, vehicle_id, start_date, end_date, reason, note,
        recorded_by, recorded_by_membership_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id`,
    [
      input.operatorId, input.vehicleId, input.startDate, input.endDate,
      input.reason, input.note ?? null,
      input.recordedBy, input.recordedByMembershipId ?? null,
    ],
  )
  return { id: (rows[0]?.['id'] as string) ?? null }
}

/**
 * Cleared rather than deleted: a cancelled booking that cost an enquiry can
 * still be explained afterwards.
 */
export async function releaseAvailability(
  run: QueryRunner,
  input: { operatorId: string; id: string; releasedBy: string },
): Promise<{ released: boolean }> {
  const rows = await run(
    `update vehicle_availability
     set released_at = now(), released_by = $3, updated_at = now()
     where id = $2 and operator_id = $1 and released_at is null
     returning id`,
    [input.operatorId, input.id, input.releasedBy],
  )
  return { released: rows.length > 0 }
}


/**
 * Recording that the operator keeps their calendar current.
 *
 * Audited, because it changes what the agent is willing to promise: with it on,
 * an empty calendar becomes "this car is free" in a message to a customer.
 * Turning it on while the calendar is not actually maintained is the single
 * most expensive mistake available on this screen.
 */
export async function setCalendarComplete(
  run: QueryRunner,
  input: { operatorId: string; complete: boolean; membershipId: string },
): Promise<void> {
  await run(
    `with updated as (
       update operators set availability_calendar_complete = $2, updated_at = now()
       where id = $1 returning id
     )
     insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
     select $1, 'human', 'availability.calendar_complete_changed', 'operator', u.id,
            jsonb_build_object('complete', $2::boolean, 'membership_id', $3::uuid)
     from updated u`,
    [input.operatorId, input.complete, input.membershipId],
  )
}
