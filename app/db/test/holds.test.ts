import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkCalendar } from '../src/queries/availability.ts'
import { requestBooking } from '../src/queries/bookings.ts'
import { followUpFacts } from '../src/queries/follow-up-facts.ts'
import { activeHoldFor, holdCar, releaseExpiredHolds } from '../src/queries/holds.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * "Let me check with my wife" used to end a sale: the price stood, the car did
 * not. A hold keeps it theirs for a while, and lets go on its own.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CAR = '44444444-4444-4444-4444-444444444444'
const MINE = '66666666-6666-6666-6666-666666666666'
const THEIRS = '77777777-7777-7777-7777-777777777777'

let db: PGlite
let run: QueryRunner
let transact: Transactor

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
    insert into operators (id, name, timezone, availability_calendar_complete, auto_confirm_bookings, hold_minutes)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', true, true, 120);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values
      ('55555555-5555-5555-5555-555555555555', '${OP}', '9715001'),
      ('55555555-5555-5555-5555-555555555556', '${OP}', '9715002');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id) values
      ('${MINE}', '${OP}', '55555555-5555-5555-5555-555555555555', '${ACCOUNT}'),
      ('${THEIRS}', '${OP}', '55555555-5555-5555-5555-555555555556', '${ACCOUNT}');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic',
            'D 2', 'V2', 'operator_confirmed', 'Owner');
  `)
})

const quoteFor = async (conversationId: string) => {
  const [e] = await run(
    `insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, conversationId])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         total_minor, lines, start_date, end_date, days, valid_until)
     values ($1, $2, $3, $4, 1, 'draft', 1500000, '[]'::jsonb, '2099-01-01', '2099-01-03', 2,
             now() + interval '2 days') returning id`,
    [OP, conversationId, e!['id'], CAR])
  return { quoteId: q!['id'] as string, enquiryId: e!['id'] as string }
}

const calendarFor = (conversationId: string) =>
  checkCalendar(run, {
    operatorId: OP, vehicleId: CAR, startDate: '2099-01-01', endDate: '2099-01-03', conversationId,
  })

describe('holding a car', () => {
  it('keeps it from everybody else, for the operator’s length of time', async () => {
    const { quoteId } = await quoteFor(MINE)
    const now = new Date()
    const held = await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId, now })
    expect(held).toMatchObject({ ok: true, vehicle: 'Ferrari 488 Spider' })
    expect((held as { until: Date }).until.getTime() - now.getTime()).toBe(120 * 60_000)

    expect(await calendarFor(THEIRS)).toMatchObject({ state: 'booked', reason: 'held' })
  })

  /** Nearly shipped: with nobody asking, a null comparison dropped every block. */
  it('blocks a check that does not say who is asking', async () => {
    const { quoteId } = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId })
    expect(await checkCalendar(run, {
      operatorId: OP, vehicleId: CAR, startDate: '2099-01-01', endDate: '2099-01-03',
    })).toMatchObject({ state: 'booked', reason: 'held' })
  })

  it('does not stand in the way of the person it is held for', async () => {
    const { quoteId } = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId })
    expect(await calendarFor(MINE)).toEqual({ state: 'free' })
  })

  it('lets them book it, and lets go once they have', async () => {
    const { quoteId, enquiryId } = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId })
    const booked = await requestBooking(transact, { operatorId: OP, conversationId: MINE, enquiryId, quoteId })
    expect(booked).toMatchObject({ ok: true, booking: { confirmed: true } })
    expect(await activeHoldFor(run, { operatorId: OP, conversationId: MINE })).toBeNull()
  })

  it('stops holding once the time is up', async () => {
    const { quoteId } = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId })
    await run(`update vehicle_availability set expires_at = now() - interval '1 minute'`, [])
    expect(await calendarFor(THEIRS)).toEqual({ state: 'free' })
    expect(await releaseExpiredHolds(run)).toBe(1)
  })

  it('will not hold a car somebody else is holding', async () => {
    const mine = await quoteFor(MINE)
    const theirs = await quoteFor(THEIRS)
    await holdCar(transact, { operatorId: OP, conversationId: THEIRS, quoteId: theirs.quoteId })
    expect(await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId: mine.quoteId }))
      .toMatchObject({ ok: false, reason: 'taken' })
  })

  it('holds one car at a time for one conversation', async () => {
    const first = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId: first.quoteId })
    // They asked about the same car again; the new price supersedes the old.
    await run(`update quotes set state = 'superseded' where id = $1`, [first.quoteId])
    const second = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId: second.quoteId })
    expect(await run(
      `select 1 from vehicle_availability where released_at is null and held_for_conversation_id = $1`,
      [MINE])).toHaveLength(1)
  })

  it('is not offered where the operator does not hold cars', async () => {
    await run(`update operators set hold_minutes = null`, [])
    const { quoteId } = await quoteFor(MINE)
    expect(await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId }))
      .toMatchObject({ ok: false, reason: 'not_offered' })
  })
})

/**
 * "Still thinking it over?" asks them to remember what they were thinking
 * about. The chase says which car, when, the price — and whether it is still
 * theirs to have.
 */
describe('what a chase says about the car', () => {
  it('names the car, the dates and the price, and that it is still available', async () => {
    await quoteFor(MINE)
    expect(await followUpFacts(run, { operatorId: OP, conversationId: MINE })).toEqual({
      text: '*Ferrari 488 Spider*, Thursday 1 January to Saturday 3 January — AED 15,000. Still available.',
      state: 'available',
    })
  })

  it('says until when it is held for them', async () => {
    const { quoteId } = await quoteFor(MINE)
    await holdCar(transact, { operatorId: OP, conversationId: MINE, quoteId })
    const facts = await followUpFacts(run, { operatorId: OP, conversationId: MINE })
    expect(facts?.state).toBe('held')
    expect(facts?.text).toMatch(/Still held for you until \d{2}:\d{2} (today|tomorrow)\.$/)
  })

  /** A chase must never offer a car that has gone since the quote. */
  it('says so when the car has gone since', async () => {
    await quoteFor(MINE)
    const theirs = await quoteFor(THEIRS)
    await holdCar(transact, { operatorId: OP, conversationId: THEIRS, quoteId: theirs.quoteId })
    expect(await followUpFacts(run, { operatorId: OP, conversationId: MINE }))
      .toMatchObject({ state: 'taken' })
  })

  it('says nothing about a car when there is no price on the table', async () => {
    expect(await followUpFacts(run, { operatorId: OP, conversationId: MINE })).toBeNull()
  })
})
