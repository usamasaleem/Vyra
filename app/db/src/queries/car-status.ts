import type { QueryRunner } from '../runner.js'

/**
 * A car off the road: in service, in the garage, damaged, or off sale.
 *
 * Kept as a block in the availability calendar rather than as a column on the
 * car, because the calendar is what every "can this car go out" question
 * already reads — the quote, the hold, confirming a booking, keeping it longer,
 * moving the dates, the waitlist. A status column would have to be taught to
 * each of them, and the one that was missed is the one that rents out a car
 * with a cracked windscreen.
 *
 * A status starts today and runs to the day before the car is back. With no
 * "back on" date it runs until somebody says otherwise — which is the risk the
 * page makes loud, since a car nobody remembers to put back is a car quietly
 * off sale.
 */
export const CAR_STATUSES = {
  // 'maintenance' is the reason the calendar already used for a car being
  // serviced, so a block entered that way by hand reads as the same status.
  maintenance: 'In service',
  garage: 'In the garage',
  damaged: 'Damaged',
  off_sale: 'Off sale',
} as const

export type CarStatus = keyof typeof CAR_STATUSES

const STATUS_REASONS = Object.keys(CAR_STATUSES)

/**
 * The end date of a status with no "back on" date.
 *
 * The calendar's dates are text compared as text, so the last day there is
 * holds every range that could be asked about without a second kind of block.
 */
export const UNTIL_FURTHER_NOTICE = '9999-12-31'

export function isCarStatus(reason: string): reason is CarStatus {
  return STATUS_REASONS.includes(reason)
}

export type CarOffTheRoad = {
  blockId: string
  vehicleId: string
  vehicleLabel: string
  status: CarStatus
  /** The first day it can be rented again, or null until somebody says. */
  backOn: string | null
  since: string
  note: string | null
  recordedBy: string
}

/** Today on the operator's clock, which is the day a status starts. */
const TODAY = `to_char(now() at time zone o.timezone, 'YYYY-MM-DD')`

/**
 * The cars that cannot go out today, and until when.
 *
 * Only blocks nobody's booking or hold wrote: a status is something a person
 * says about the car, never about a customer.
 */
export async function listCarsOffTheRoad(
  run: QueryRunner,
  operatorId: string,
): Promise<CarOffTheRoad[]> {
  const rows = await run(
    `select a.id, a.vehicle_id, a.reason, a.start_date, a.end_date, a.note, a.recorded_by,
            v.make || ' ' || v.model || coalesce(' ' || v.variant, '') as vehicle_label
     from vehicle_availability a
     join vehicles v on v.id = a.vehicle_id and v.operator_id = a.operator_id
     join operators o on o.id = a.operator_id
     where a.operator_id = $1 and a.released_at is null
       and a.booking_id is null and a.held_for_conversation_id is null
       and a.reason = any($2::text[])
       and a.start_date <= ${TODAY} and a.end_date >= ${TODAY}
     order by v.make, v.model, a.start_date`,
    [operatorId, STATUS_REASONS],
  )

  return rows.map((r) => ({
    blockId: r['id'] as string,
    vehicleId: r['vehicle_id'] as string,
    vehicleLabel: r['vehicle_label'] as string,
    status: r['reason'] as CarStatus,
    backOn: backOnFrom(r['end_date'] as string),
    since: r['start_date'] as string,
    note: (r['note'] as string) ?? null,
    recordedBy: r['recorded_by'] as string,
  }))
}

/** The day after the last day off, or null for a status with no end. */
export function backOnFrom(endDate: string): string | null {
  if (endDate === UNTIL_FURTHER_NOTICE) return null
  const next = new Date(`${endDate}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export type SetCarStatus =
  | {
      ok: true
      /**
       * Customers' bookings that fall inside the time off. The status is
       * recorded anyway — the car cannot be driven whatever the calendar says —
       * but somebody has to call those customers, and they need telling so.
       */
      clashingBookings: number
    }
  | { ok: false; reason: 'back_on_not_after_today' | 'no_such_car'; detail: string }

/**
 * Setting a car's status, or putting it back on the road.
 *
 * Replaces whatever status the car has today rather than adding to it: a car
 * moved from "damaged" to "in the garage until Monday" has one reason it is
 * off, not two, and the older one must not outlive the newer. Cleared rather
 * than deleted, so the record still explains a customer told no last week.
 */
export async function setCarStatus(
  run: QueryRunner,
  input: {
    operatorId: string
    vehicleId: string
    status: CarStatus | 'available'
    /** The first day it can be rented again. Null keeps it off until set back. */
    backOn: string | null
    note?: string | null
    recordedBy: string
    recordedByMembershipId?: string | null
  },
): Promise<SetCarStatus> {
  const [car] = await run(
    `select ${TODAY} as today
     from vehicles v join operators o on o.id = v.operator_id
     where v.id = $1 and v.operator_id = $2`,
    [input.vehicleId, input.operatorId],
  )
  if (car === undefined) {
    return { ok: false, reason: 'no_such_car', detail: 'That car is not in this fleet.' }
  }

  const today = car['today'] as string
  if (input.status !== 'available' && input.backOn !== null && input.backOn <= today) {
    return {
      ok: false,
      reason: 'back_on_not_after_today',
      detail: 'The day it is back has to be after today. Leave it empty if nobody knows yet.',
    }
  }

  const endDate = input.backOn === null
    ? UNTIL_FURTHER_NOTICE
    : (() => {
        const last = new Date(`${input.backOn}T00:00:00Z`)
        last.setUTCDate(last.getUTCDate() - 1)
        return last.toISOString().slice(0, 10)
      })()

  // One statement, so a car is never left between its old status and its new
  // one — cleared and not yet set is a car the agent would sell. PostgreSQL
  // runs a data-modifying WITH whether or not the insert reads it.
  await run(
    `with released as (
       update vehicle_availability a
       set released_at = now(), released_by = $3, updated_at = now()
       where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
         and a.booking_id is null and a.held_for_conversation_id is null
         and a.reason = any($4::text[])
         and a.start_date <= $5 and a.end_date >= $5
       returning a.id
     )
     insert into vehicle_availability
       (operator_id, vehicle_id, start_date, end_date, reason, note,
        recorded_by, recorded_by_membership_id)
     select $1, $2, $5, $6, $7, $8, $3, $9
     where $7::text <> 'available'`,
    [
      input.operatorId, input.vehicleId, input.recordedBy, STATUS_REASONS, today,
      endDate, input.status, input.note ?? null, input.recordedByMembershipId ?? null,
    ],
  )

  if (input.status === 'available') return { ok: true, clashingBookings: 0 }

  const [clash] = await run(
    `select count(*)::int as n from vehicle_availability a
     where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
       and a.booking_id is not null
       and a.start_date <= $4 and a.end_date >= $3`,
    [input.operatorId, input.vehicleId, today, endDate],
  )
  return { ok: true, clashingBookings: Number(clash?.['n'] ?? 0) }
}
