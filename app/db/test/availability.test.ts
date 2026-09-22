import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkCalendar, listAvailability, recordUnavailable, releaseAvailability,
} from '../src/queries/availability.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let run: QueryRunner
let vehicleId: string

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');`)
  const [v] = await run(
    `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by)
     values ($1,'Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 1','VIN1',
             'operator_confirmed','Owner') returning id`,
    [OP],
  )
  vehicleId = v!['id'] as string
})

const block = (startDate: string, endDate: string, reason = 'booked') =>
  recordUnavailable(run, {
    operatorId: OP, vehicleId, startDate, endDate, reason, recordedBy: 'Sara',
  })

const check = (startDate: string, endDate: string | null) =>
  checkCalendar(run, { operatorId: OP, vehicleId, startDate, endDate })

describe('checkCalendar', () => {
  it('answers no when a booking covers the dates', async () => {
    await block('2026-10-20', '2026-10-23')
    expect(await check('2026-10-21', '2026-10-22'))
      .toMatchObject({ state: 'booked', until: '2026-10-23', reason: 'booked' })
  })

  /** Overlap, not containment: part of the range taken is the range not free. */
  it.each([
    ['2026-10-18', '2026-10-21'],
    ['2026-10-22', '2026-10-25'],
    ['2026-10-19', '2026-10-24'],
    ['2026-10-20', '2026-10-20'],
    ['2026-10-23', null],
  ])('answers no when %s to %s overlaps at all', async (start, end) => {
    await block('2026-10-20', '2026-10-23')
    expect((await check(start, end as string | null)).state).toBe('booked')
  })

  it.each([
    ['2026-10-24', '2026-10-26'],
    ['2026-10-17', '2026-10-19'],
  ])('says nothing about %s to %s, which does not overlap', async (start, end) => {
    await block('2026-10-20', '2026-10-23')
    expect((await check(start, end)).state).toBe('unknown')
  })

  /**
   * The distinction the whole design rests on. An empty calendar says nobody
   * recorded a booking, which is a fact about the calendar and not about the
   * car. Treating it as "free" is how an agent promises a vehicle already out.
   */
  it('is unknown, not free, when nothing is booked', async () => {
    expect(await check('2026-10-20', '2026-10-23')).toEqual({ state: 'unknown' })
  })

  it('is free only once the operator says their calendar is complete', async () => {
    await run(`update operators set availability_calendar_complete = true where id = $1`, [OP])
    expect(await check('2026-10-20', '2026-10-23')).toEqual({ state: 'free' })
  })

  it('still answers no from a complete calendar', async () => {
    await run(`update operators set availability_calendar_complete = true where id = $1`, [OP])
    await block('2026-10-20', '2026-10-23')
    expect((await check('2026-10-21', '2026-10-22')).state).toBe('booked')
  })

  it('ignores a booking that was released', async () => {
    const { id } = await block('2026-10-20', '2026-10-23')
    await releaseAvailability(run, { operatorId: OP, id: id!, releasedBy: 'Sara' })
    expect((await check('2026-10-21', '2026-10-22')).state).toBe('unknown')
  })

  it('belongs to one operator', async () => {
    await block('2026-10-20', '2026-10-23')
    expect(await checkCalendar(run, {
      operatorId: '11111111-1111-1111-1111-1111111111bb',
      vehicleId, startDate: '2026-10-21', endDate: '2026-10-22',
    })).toMatchObject({ state: 'unknown' })
  })
})

describe('the calendar a person reads', () => {
  it('shows what is coming and hides what was released', async () => {
    await block('2099-10-20', '2099-10-23')
    const { id } = await block('2099-11-01', '2099-11-03')
    await releaseAvailability(run, { operatorId: OP, id: id!, releasedBy: 'Sara' })

    const open = await listAvailability(run, OP)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      vehicleLabel: 'Lamborghini Huracán Tecnica', startDate: '2099-10-20', recordedBy: 'Sara',
    })

    // The released one is history, and history is still readable.
    expect(await listAvailability(run, OP, { includeReleased: true })).toHaveLength(2)
  })

  it('leaves yesterday out of the calendar', async () => {
    await block('2020-01-01', '2020-01-05')
    expect(await listAvailability(run, OP)).toHaveLength(0)
  })
})

describe('what the database refuses', () => {
  it('refuses a block that ends before it starts', async () => {
    await expect(block('2026-10-23', '2026-10-20')).rejects.toThrow()
  })

  /** A booking that vanished with no name against it cannot be explained. */
  it('refuses an anonymous release', async () => {
    const { id } = await block('2026-10-20', '2026-10-23')
    await expect(run(
      `update vehicle_availability set released_at = now() where id = $1`, [id],
    )).rejects.toThrow()
  })
})

/**
 * Being told your own car is taken.
 *
 * Read live: a customer booked the Huracán for the 25th to the 27th, asked
 * for it again a quarter of an hour later, and was told it was already taken.
 * He replied "i only want lambo", and the agent raised a task asking a
 * colleague whether the car could be released — for the person who had
 * booked it.
 *
 * Nothing was wrong with the check. A hold is a hold, and the query had no
 * way to ask whose it was, so "taken" was the only honest answer available.
 * It is the wrong answer to this customer.
 */
describe('whose hold it is', () => {
  const CONV = '66666666-6666-6666-6666-666666666666'
  const OTHER_CONV = '77777777-7777-7777-7777-777777777777'

  beforeEach(async () => {
    await run(
      `insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
       values ('33333333-3333-3333-3333-333333333333', $1, 'waba', '111')`, [OP])
    for (const [conv, phone] of [[CONV, '9715001'], [OTHER_CONV, '9715002']] as const) {
      const [ct] = await run(
        `insert into contacts (operator_id, channel_identifier) values ($1,$2) returning id`,
        [OP, phone])
      await run(
        `insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
         values ($1,$2,$3,'33333333-3333-3333-3333-333333333333')`,
        [conv, OP, ct!['id']])
    }
  })

  const held = async (conversationId: string | null) => {
    const [q] = await run(
      `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state,
                           total_minor, lines, start_date, end_date, days)
       values ($1,$2,$3,1,'draft',1000000,'[]'::jsonb,'2026-09-25','2026-09-27',2)
       returning id`,
      [OP, conversationId ?? CONV, vehicleId],
    )
    const [b] = await run(
      `insert into bookings (operator_id, conversation_id, quote_id, state, decided_at)
       values ($1,$2,$3,'confirmed',now()) returning id`,
      [OP, conversationId ?? CONV, q!['id']],
    )
    await run(
      `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date,
                                         reason, recorded_by, booking_id)
       values ($1,$2,'2026-09-25','2026-09-27','booked','booking confirmed',$3)`,
      [OP, vehicleId, b!['id']],
    )
  }

  const check = (conversationId?: string) => checkCalendar(run, {
    operatorId: OP, vehicleId,
    startDate: '2026-09-25', endDate: '2026-09-27',
    conversationId: conversationId ?? null,
  })

  it('reads their own booking as theirs', async () => {
    await held(CONV)
    expect(await check(CONV)).toMatchObject({ state: 'already_theirs', until: '2026-09-27' })
  })

  it('still reads somebody else’s as taken', async () => {
    await held(CONV)
    expect(await check(OTHER_CONV)).toMatchObject({ state: 'booked' })
  })

  /** Nobody asking means nobody to compare against, so it stays a refusal. */
  it('is taken when the asker is unknown', async () => {
    await held(CONV)
    expect(await check()).toMatchObject({ state: 'booked' })
  })

  /**
   * Their own hold must not hide somebody else's. The car genuinely is not
   * theirs for the whole range, and answering "you have it" would send them
   * to collect a car another customer has.
   */
  it('prefers somebody else’s block when both overlap', async () => {
    await held(CONV)
    await run(
      `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date,
                                         reason, recorded_by)
       values ($1,$2,'2026-09-26','2026-09-28','booked','somebody else')`,
      [OP, vehicleId],
    )
    expect(await check(CONV)).toMatchObject({ state: 'booked' })
  })
})
