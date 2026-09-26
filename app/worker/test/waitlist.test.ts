import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { sendWaitlistNotices } from '../src/waitlist.ts'
import { cancelForCustomer } from '../../db/src/queries/booking-changes.ts'
import { joinWaitlist } from '../../db/src/queries/waitlist.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

/**
 * The customer who wanted a booked car, told when it comes free.
 *
 * The whole promise is timing and order: nothing while the car is taken,
 * everybody waiting within a sweep of it freeing up, oldest first, once — and
 * the car to whoever books it, which the calendar already decides.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const CAR = '77777777-7777-7777-7777-777777777777'
const HOLDER = '66666666-6666-6666-6666-000000000000'
const FIRST = '66666666-6666-6666-6666-000000000001'
const SECOND = '66666666-6666-6666-6666-000000000002'
/** Midday in Dubai. */
const NOW = new Date('2026-10-01T08:00:00Z')
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

let db: PGlite
let run: QueryRunner
let transact: Transactor
const silently = () => {}

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
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into vehicles (id, operator_id, make, model, year, colour, category, plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Lamborghini', 'Huracán', 2023, 'Verde', 'exotic', 'D 1', 'V1', 'operator_confirmed', 'Owner');
  `)
  for (const [i, conv] of [HOLDER, FIRST, SECOND].entries()) {
    const contact = `55555555-5555-5555-5555-00000000000${i}`
    await run(`insert into contacts (id, operator_id, channel_identifier, display_name) values ($1, $2, $3, $4)`,
      [contact, OP, `97150000000${i}`, ['Omar', 'James Hart', 'Layla'][i]])
    await run(
      `insert into conversations (id, operator_id, contact_id, whatsapp_account_id, last_customer_message_at)
       values ($1, $2, $3, $4, $5)`, [conv, OP, contact, ACCOUNT, hoursBefore(2)])
    await run(`insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
               values ($1, $2, 'inbound', 'text', 'hi', $3)`, [OP, conv, `wamid.${i}`])
  }
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state, total_minor, lines, start_date, end_date, days,
                         approved_by_membership_id, approved_at)
     values ($1, $2, $3, 1, 'sent', 1000000, '[]'::jsonb, '2026-10-10', '2026-10-12', 2, $4, now()) returning id`,
    [OP, HOLDER, CAR, MEMBER])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, quote_id, state, decided_at)
     values ($1, $2, $3, 'confirmed', now()) returning id`, [OP, HOLDER, q!['id']])
  await run(
    `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason, recorded_by, booking_id)
     values ($1, $2, '2026-10-10', '2026-10-12', 'booked', 'test', $3)`, [OP, CAR, b!['id']])
})

const wait = async (conversationId: string, startDate = '2026-10-11', endDate = '2026-10-12') => {
  const joined = await joinWaitlist(run, { operatorId: OP, conversationId, vehicleId: CAR, startDate, endDate })
  expect(joined).toMatchObject({ ok: true })
  return joined
}
const sweep = (now = NOW) => sendWaitlistNotices(run, silently, { now })
const cancelTheBooking = () => cancelForCustomer(transact, { operatorId: OP, conversationId: HOLDER })
const told = () => run(
  `select conversation_id, kind::text as kind, body, idempotency_key from messages
   where direction = 'outbound' order by created_at, conversation_id`, [])
const entries = () => run(`select conversation_id, closed_reason from waitlist_entries order by created_at`, [])

describe('waiting for a booked car', () => {
  it('only takes a place for a car the calendar says is booked', async () => {
    expect(await joinWaitlist(run, { operatorId: OP, conversationId: FIRST, vehicleId: CAR, startDate: '2026-10-20', endDate: '2026-10-21' }))
      .toMatchObject({ ok: false, reason: 'not_booked' })
    expect(await joinWaitlist(run, { operatorId: OP, conversationId: HOLDER, vehicleId: CAR, startDate: '2026-10-10', endDate: '2026-10-11' }))
      .toMatchObject({ ok: false, reason: 'theirs' })
    expect(await wait(FIRST)).toEqual({ ok: true, added: true, ahead: 0 })
    expect(await wait(SECOND)).toEqual({ ok: true, added: true, ahead: 1 })
    expect(await wait(FIRST)).toEqual({ ok: true, added: false, ahead: 0 })
  })

  it('says nothing while the car is still taken', async () => {
    await wait(FIRST)
    expect(await sweep()).toEqual({ sent: 0, raisedForAPerson: 0 })
    expect(await told()).toEqual([])
  })

  it('tells everybody waiting once it is cancelled, oldest first, and only once', async () => {
    await wait(FIRST)
    await wait(SECOND)
    await cancelTheBooking()

    expect(await sweep()).toEqual({ sent: 2, raisedForAPerson: 0 })
    const messages = await told()
    expect(messages.map((m) => m['conversation_id'])).toEqual([FIRST, SECOND])
    expect(messages[0]!['body']).toBe('Good news — the *Lamborghini Huracán* is available for Sunday 11 October to Monday 12 October after all. Shall I book it for you?')
    expect(await entries()).toEqual([
      { conversation_id: FIRST, closed_reason: 'notified' },
      { conversation_id: SECOND, closed_reason: 'notified' },
    ])

    expect(await sweep()).toEqual({ sent: 0, raisedForAPerson: 0 })
    expect(await told()).toHaveLength(2)
  })

  it('waits for morning when the car frees up in the night', async () => {
    await wait(FIRST)
    await cancelTheBooking()
    expect(await sweep(new Date('2026-09-30T22:00:00Z'))).toEqual({ sent: 0, raisedForAPerson: 0 })
    expect(await entries()).toEqual([{ conversation_id: FIRST, closed_reason: null }])
  })

  it('past the 24 hours sends the approved template, and without one makes it a task', async () => {
    await wait(FIRST)
    await wait(SECOND)
    await run(`update conversations set last_customer_message_at = $1 where id in ($2, $3)`, [hoursBefore(30), FIRST, SECOND])
    await cancelTheBooking()

    expect(await sweep()).toEqual({ sent: 0, raisedForAPerson: 2 })
    const [conv] = await run(`select next_action from conversations where id = $1`, [FIRST])
    expect(conv!['next_action']).toMatch(/Lamborghini Huracán they were waiting for is now available/)
    expect(await told()).toEqual([])

    // Waiting again, and this time the operator has the template.
    await run(`insert into waitlist_entries (operator_id, conversation_id, vehicle_id, start_date, end_date)
               values ($1, $2, $3, '2026-10-11', '2026-10-12')`, [OP, FIRST, CAR])
    await run(
      `insert into whatsapp_templates (operator_id, name, language, category, body, status)
       values ($1, 'vyra_waitlist_available', 'en', 'UTILITY', 'x', 'APPROVED')`, [OP])
    expect(await sweep()).toEqual({ sent: 1, raisedForAPerson: 0 })
    const [message] = await told()
    expect(message).toMatchObject({ conversation_id: FIRST, kind: 'template' })
    expect(message!['body']).toMatch(/^Hello James, good news: the Lamborghini Huracán you asked us to watch for is now available for Sunday 11 October to Monday 12 October\./)
  })

  it('leaves a note for the person running the conversation instead of messaging over them', async () => {
    await wait(FIRST)
    await run(`update conversations set handler_mode = 'human' where id = $1`, [FIRST])
    await cancelTheBooking()
    expect(await sweep()).toEqual({ sent: 0, raisedForAPerson: 1 })
    expect(await told()).toEqual([])
    const [note] = await run(`select body from conversation_notes where conversation_id = $1`, [FIRST])
    expect(note!['body']).toMatch(/^Waitlist: tell them the Lamborghini Huracán/)
  })

  it('lets go once the first day has passed, or once they have booked those dates', async () => {
    await wait(FIRST)
    await wait(SECOND)
    const [q] = await run(
      `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state, total_minor, lines, start_date, end_date, days,
                           approved_by_membership_id, approved_at)
       values ($1, $2, $3, 1, 'sent', 1000000, '[]'::jsonb, '2026-10-11', '2026-10-12', 1, $4, now()) returning id`,
      [OP, SECOND, CAR, MEMBER])
    await run(`insert into bookings (operator_id, conversation_id, quote_id, state, decided_at, created_at)
               values ($1, $2, $3, 'requested', now(), now() + interval '1 minute')`, [OP, SECOND, q!['id']])
    await sweep()
    expect(await entries()).toEqual([
      { conversation_id: FIRST, closed_reason: null },
      { conversation_id: SECOND, closed_reason: 'booked' },
    ])
    await sweep(new Date('2026-10-12T08:00:00Z'))
    expect(await entries()).toEqual([
      { conversation_id: FIRST, closed_reason: 'expired' },
      { conversation_id: SECOND, closed_reason: 'booked' },
    ])
  })
})
