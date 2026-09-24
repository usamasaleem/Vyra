import type { QueryRunner, Transactor } from '../runner.js'

/**
 * Holding a car for somebody who is deciding.
 *
 * "Let me check with my wife" used to end a sale: the price stood, the car did
 * not, and whoever booked first got it. A hold is a reason to come back — the
 * car is theirs until a stated time, and after it the calendar lets go on its
 * own.
 *
 * It lives in the same table as every other block, so everything that decides
 * whether a car is free sees it without being taught a new idea. It blocks the
 * car for everybody except the conversation it is for, and a hold that has run
 * out blocks nobody even before the sweep marks it released.
 *
 * One per conversation. A second hold replaces the first: somebody weighing
 * the Ferrari and then the Huracán is holding one car, not the fleet.
 */
export type HoldRefusal =
  | 'not_offered'
  | 'no_quote'
  | 'taken'
  | 'already_booked'

export type HoldResult =
  | { ok: true; until: Date; vehicle: string | null; startDate: string; endDate: string }
  | { ok: false; reason: HoldRefusal; detail: string }

export async function holdCar(
  transact: Transactor,
  input: { operatorId: string; conversationId: string; quoteId: string; now?: Date },
): Promise<HoldResult> {
  if (!/^[0-9a-f-]{36}$/i.test(input.quoteId)) {
    return { ok: false, reason: 'no_quote', detail: 'That is not a quote id. Pass the quoteId prepare_quote returned.' }
  }
  const now = input.now ?? new Date()

  return transact(async (tx) => {
    const [row] = await tx(
      `select q.id, q.vehicle_id, q.start_date::date::text as start_date,
              coalesce(q.end_date, q.start_date)::date::text as end_date,
              q.state::text as state, q.valid_until,
              o.hold_minutes,
              trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle
       from quotes q
       join operators o on o.id = q.operator_id
       left join vehicles v on v.id = q.vehicle_id and v.operator_id = q.operator_id
       where q.id = $1 and q.operator_id = $2 and q.conversation_id = $3`,
      [input.quoteId, input.operatorId, input.conversationId],
    )
    if (row === undefined) {
      return { ok: false, reason: 'no_quote', detail: 'No quote with that id in this conversation. Price the car first.' }
    }
    if (row['hold_minutes'] == null) {
      return { ok: false, reason: 'not_offered', detail: 'This operator does not hold cars. Do not offer a hold.' }
    }
    if (['superseded', 'rejected', 'expired'].includes(row['state'] as string)
      || (row['valid_until'] != null && new Date(row['valid_until'] as string) <= now)) {
      return { ok: false, reason: 'no_quote', detail: 'That price is no longer current. Price it again first.' }
    }
    if (row['vehicle_id'] == null || row['start_date'] == null) {
      return { ok: false, reason: 'no_quote', detail: 'That quote has no car or no dates to hold.' }
    }

    const [booked] = await tx(
      // Confirmed only: a booking waiting for a person is exactly what a hold
      // protects — a long rental must not be lost while somebody checks it.
      `select 1 from bookings where quote_id = $1 and operator_id = $2
         and state = 'confirmed' limit 1`,
      [input.quoteId, input.operatorId],
    )
    if (booked !== undefined) {
      return { ok: false, reason: 'already_booked', detail: 'They have already booked this — there is nothing to hold.' }
    }

    // The same lock every confirmation takes, so a hold and a booking cannot
    // both win the same car.
    await tx(`select id from vehicles where id = $1 and operator_id = $2 for update`,
      [row['vehicle_id'], input.operatorId])

    const [clash] = await tx(
      `select 1 from vehicle_availability a
       where a.operator_id = $1 and a.vehicle_id = $2 and a.released_at is null
         and a.start_date <= $4 and a.end_date >= $3
         and (a.expires_at is null or a.expires_at > now())
         and a.held_for_conversation_id is distinct from $5::uuid
       limit 1`,
      [input.operatorId, row['vehicle_id'], row['start_date'], row['end_date'], input.conversationId],
    )
    if (clash !== undefined) {
      return { ok: false, reason: 'taken', detail: 'The car is not free for those dates any more. Say so and offer another.' }
    }

    await releaseHoldsFor(tx, {
      operatorId: input.operatorId, conversationId: input.conversationId, why: 'replaced by a new hold',
    })

    const until = new Date(now.getTime() + Number(row['hold_minutes']) * 60_000)
    await tx(
      `insert into vehicle_availability
         (operator_id, vehicle_id, start_date, end_date, reason, recorded_by,
          held_for_conversation_id, held_for_quote_id, expires_at)
       values ($1, $2, $3, $4, 'held', 'held by the agent', $5, $6, $7)`,
      [
        input.operatorId, row['vehicle_id'], row['start_date'], row['end_date'],
        input.conversationId, input.quoteId, until.toISOString(),
      ],
    )
    return {
      ok: true,
      until,
      vehicle: (row['vehicle'] as string) ?? null,
      startDate: row['start_date'] as string,
      endDate: row['end_date'] as string,
    }
  })
}

export type ActiveHold = {
  vehicle: string | null
  quoteId: string | null
  startDate: string
  endDate: string
  until: Date
}

/** The hold this conversation has right now, if any. */
export async function activeHoldFor(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<ActiveHold | null> {
  const [row] = await run(
    `select a.start_date, a.end_date, a.expires_at, a.held_for_quote_id,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle
     from vehicle_availability a
     left join vehicles v on v.id = a.vehicle_id and v.operator_id = a.operator_id
     where a.operator_id = $1 and a.held_for_conversation_id = $2
       and a.released_at is null and a.expires_at > now()
     order by a.expires_at desc
     limit 1`,
    [input.operatorId, input.conversationId],
  )
  if (row === undefined) return null
  return {
    vehicle: (row['vehicle'] as string) ?? null,
    quoteId: (row['held_for_quote_id'] as string) ?? null,
    startDate: row['start_date'] as string,
    endDate: row['end_date'] as string,
    until: new Date(row['expires_at'] as string),
  }
}

/** Let go of whatever this conversation holds — because they booked, or chose again. */
export async function releaseHoldsFor(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; why: string },
): Promise<number> {
  const rows = await run(
    `update vehicle_availability
     set released_at = now(), released_by = $3, updated_at = now()
     where operator_id = $1 and held_for_conversation_id = $2 and released_at is null
     returning id`,
    [input.operatorId, input.conversationId, input.why],
  )
  return rows.length
}

/**
 * Mark the holds that ran out as released, so the calendar reads true to a
 * person too. The overlap checks already ignore an expired hold; this is for
 * the record and the Availability page.
 */
export async function releaseExpiredHolds(run: QueryRunner): Promise<number> {
  const rows = await run(
    `update vehicle_availability
     set released_at = now(), released_by = 'hold expired', updated_at = now()
     where held_for_conversation_id is not null and released_at is null and expires_at <= now()
     returning id`,
    [],
  )
  return rows.length
}
