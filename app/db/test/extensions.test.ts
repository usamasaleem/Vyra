import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { extendableBooking, extendBooking } from '../src/queries/extensions.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * Keeping the car longer: the most common thing a customer asks once they
 * have it, and the one thing the agent could never do.
 *
 * An extension is deliberately a booking — a quote for the extra days, a
 * booking row against it, the same overlap check behind the same lock, the
 * same rule about whether the agent may settle it. What these assert is that
 * it really does reuse those and is not a parallel path that would need
 * fixing twice.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '88888888-8888-8888-8888-888888888888'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const CAR = '44444444-4444-4444-4444-444444444444'

let db: PGlite
let run: QueryRunner
let transact: Transactor

/** Relative to the run, because a hold in the past is a hold nobody checks. */
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

const START = () => inDays(3)
const END = () => inDays(5)

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, availability_calendar_complete, auto_confirm_bookings)
    values ('${OP}', 'Vyra Pilot', true, true);
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Ahmed');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic',
            'D 2', 'V2', 'operator_confirmed', 'Owner');
    insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                               minimum_days, provenance, confirmed_by, confirmed_at)
    values ('${OP}', '${CAR}', 'AED', 500000, 1, 'operator_confirmed', 'Owner', now());
  `)
})

/** A rental already confirmed and held, which is what an extension extends. */
const confirmedBooking = async () => {
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state,
                         total_minor, lines, start_date, end_date, days, valid_until,
                         approved_by_membership_id, approved_at)
     values ($1,$2,$3,1,'sent',1000000,'[]'::jsonb,$4::timestamptz,$5::timestamptz,2,
             now() + interval '5 days', $6, now())
     returning id`,
    [OP, CONV, CAR, START(), END(), MEMBER],
  )
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, quote_id, state, decided_at,
                           decided_by_membership_id)
     values ($1,$2,$3,'confirmed',now(),$4) returning id`,
    [OP, CONV, q!['id'], MEMBER],
  )
  await run(
    `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date,
                                       reason, recorded_by, booking_id)
     values ($1,$2,$3,$4,'booked','booking confirmed',$5)`,
    [OP, CAR, START(), END(), b!['id']],
  )
  return b!['id'] as string
}

describe('finding the rental to extend', () => {
  it('is the confirmed one in this conversation', async () => {
    const id = await confirmedBooking()
    expect(await extendableBooking(run, { operatorId: OP, conversationId: CONV }))
      .toMatchObject({ bookingId: id, vehicle: 'Ferrari 488 Spider', endDate: END() })
  })

  it('is nothing when they have not booked', async () => {
    expect(await extendableBooking(run, { operatorId: OP, conversationId: CONV })).toBeNull()
  })
})

describe('keeping the car longer', () => {
  const extend = async (to: string, membershipId: string | null = null) =>
    extendBooking(transact, {
      operatorId: OP, bookingId: await confirmedBooking(), newEndDate: to, membershipId,
    })

  /**
   * Two conventions meet in this number and getting it wrong costs a day's
   * rental every time. A hold is inclusive of its end date; a quote treats
   * the end as the day the car comes back. A rental running to day 5 and
   * extended to day 7 is two more days of rental — the customer stops
   * returning it on day 5 and keeps it — and two more days of hold, 6 and 7,
   * because day 5 was already held.
   */
  it('prices the days they keep it, and holds the days that were not held', async () => {
    const result = await extend(inDays(7))
    expect(result).toMatchObject({
      ok: true,
      extension: {
        fromDate: inDays(6), toDate: inDays(7),
        extraDays: 2, extraMinor: 1000000,
      },
    })
  })

  /** Adjacent, not overlapping — which is what lets it be an ordinary booking. */
  it('holds the extra days without disturbing the original', async () => {
    await extend(inDays(7))
    const holds = await run(
      `select start_date, end_date from vehicle_availability where released_at is null
       order by start_date`, [])
    expect(holds.map((h) => [h['start_date'], h['end_date']]))
      .toEqual([[START(), END()], [inDays(6), inDays(7)]])
  })

  it('settles it on the spot when the operator allows that', async () => {
    const result = await extend(inDays(7))
    const id = (result as { extension: { bookingId: string } }).extension.bookingId
    const [row] = await run(
      `select state::text as state, decided_automatically from bookings where id = $1`, [id])
    expect(row).toMatchObject({ state: 'confirmed', decided_automatically: true })
  })

  it('leaves it for a person when the operator has not', async () => {
    await run(`update operators set auto_confirm_bookings = false where id = $1`, [OP])
    const result = await extend(inDays(7))
    expect(result).toMatchObject({ ok: true, extension: { confirmed: false } })
    expect(await run(`select id from vehicle_availability where reason = 'booked'`, []))
      .toHaveLength(1)
  })

  /** The disaster this shares with a first booking. */
  it('refuses when somebody else has the car for those days', async () => {
    const id = await confirmedBooking()
    await run(
      `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date,
                                         reason, recorded_by)
       values ($1,$2,$3,$4,'booked','somebody else')`,
      [OP, CAR, inDays(7), inDays(8)],
    )

    const result = await extendBooking(transact, {
      operatorId: OP, bookingId: id, newEndDate: inDays(8), membershipId: null,
    })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'taken', until: inDays(8) } })
  })

  it('says nothing was booked when nothing was', async () => {
    expect(await extendBooking(transact, {
      operatorId: OP, bookingId: '00000000-0000-0000-0000-000000000000', newEndDate: inDays(9),
      membershipId: null,
    })).toMatchObject({ ok: false, refusal: { reason: 'no_booking' } })
  })

  /** Shortening, or moving the dates, is a person's job. */
  it('refuses a date that is not later', async () => {
    expect(await extend(END())).toMatchObject({ ok: false, refusal: { reason: 'not_later' } })
    expect(await extend(inDays(4))).toMatchObject({ ok: false, refusal: { reason: 'not_later' } })
  })

  it('will not extend something nobody confirmed', async () => {
    const [q] = await run(
      `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state,
                           total_minor, lines, start_date, end_date, days)
       values ($1,$2,$3,1,'draft',1000000,'[]'::jsonb,$4::timestamptz,$5::timestamptz,2)
       returning id`,
      [OP, CONV, CAR, START(), END()],
    )
    const [b] = await run(
      `insert into bookings (operator_id, conversation_id, quote_id, state)
       values ($1,$2,$3,'requested') returning id`, [OP, CONV, q!['id']])

    expect(await extendBooking(transact, {
      operatorId: OP, bookingId: b!['id'] as string, newEndDate: inDays(7), membershipId: null,
    })).toMatchObject({ ok: false, refusal: { reason: 'not_confirmed' } })
  })

  /** A person extending is not subject to the agent's ceiling. */
  it('lets a person extend past the agent ceiling', async () => {
    await run(`update operators set auto_confirm_limit_minor = 1 where id = $1`, [OP])
    const result = await extend(inDays(7), MEMBER)
    expect(result).toMatchObject({ ok: true, extension: { confirmed: true } })
  })
})
