import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createToolBoundary } from '../src/tools/boundary.ts'
import type { ToolContext } from '../src/tools/context.ts'
import { toolDefinitions, TOOL_NAMES } from '../src/tools/schemas.ts'
import { draftKnowledge, publishKnowledge } from '../../db/src/queries/knowledge.ts'
import { ensureEnquiry } from '../../db/src/queries/enquiry-fields.ts'
import { queueOutboundText } from '../../db/src/queries/outbound.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const RIVAL_MEMBER = '44444444-4444-4444-4444-4444444444aa'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const TZ = 'Asia/Dubai'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let ctx: ToolContext

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
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', '${TZ}'), ('${RIVAL}', 'Rival', '${TZ}');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role, display_name) values
      ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson', 'Ahmed'),
      ('${RIVAL_MEMBER}', '${RIVAL}', '10000000-0000-0000-0000-000000000002', 'salesperson', 'Omar');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const m = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', 'Ferrari from Friday', 'wamid.1') returning id`,
    [OP, CONV],
  )
  ctx = {
    operatorId: OP,
    conversationId: CONV,
    enquiryId: (await ensureEnquiry(run, OP, CONV))!,
    messageId: m[0]!['id'] as string,
    timezone: TZ,
    now: new Date('2026-09-14T08:00:00Z'),
    run,
    transact,
  }
})

async function publish(topic: string, answer: string) {
  const draft = await draftKnowledge(run, { operatorId: OP, topic, answer, confirmedBy: 'Owner', confirmedByMembershipId: MEMBER })
  await publishKnowledge(transact, { operatorId: OP, entryId: draft.id, membershipId: MEMBER })
  await run(`update knowledge_entries set effective_from = '2026-09-13' where id = $1`, [draft.id])
}

const CAR = '77777777-7777-7777-7777-777777777777'

/** A confirmed Ferrari, 20th to 22nd September, AED 10,000 with the rental due. */
async function booked(paid = false) {
  await db.exec(`
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category, plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic', 'D 9', 'V9', 'operator_confirmed', 'Owner');
    insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor, minimum_days, deposit_minor, provenance, confirmed_by, confirmed_at)
    values ('${OP}', '${CAR}', 'AED', 500000, 1, 500000, 'operator_confirmed', 'Owner', now());
    update operators set availability_calendar_complete = true, auto_confirm_bookings = true where id = '${OP}';
  `)
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor, deposit_minor,
                         lines, start_date, end_date, days, approved_by_membership_id, approved_at)
     values ($1, $2, $3, $4, 1, 'sent', 1000000, 500000, '[]'::jsonb, '2026-09-20', '2026-09-22', 2, $5, now()) returning id`,
    [OP, CONV, ctx.enquiryId, CAR, MEMBER])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state, decided_at, delivery_time)
     values ($1, $2, $3, $4, 'confirmed', now(), '10:00') returning id`, [OP, CONV, ctx.enquiryId, q!['id']])
  await run(
    `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason, recorded_by, booking_id)
     values ($1, $2, '2026-09-20', '2026-09-22', 'booked', 'test', $3)`, [OP, CAR, b!['id']])
  await run(
    `insert into payments (operator_id, booking_id, conversation_id, kind, state, amount_minor, currency, paid_at, method)
     values ($1, $2, $3, 'rental', $4, 1000000, 'AED', $5, $6), ($1, $2, $3, 'deposit', 'due', 500000, 'AED', null, null)`,
    [OP, b!['id'], CONV, paid ? 'paid' : 'due', paid ? new Date().toISOString() : null, paid ? 'bank_transfer' : null])
  await run(`update conversations set booking_status = 'confirmed' where id = $1`, [CONV])
  return b!['id'] as string
}

const agentAsked = (body: string) =>
  run(`insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state)
       values ($1, $2, 'outbound', 'text', $3, 'delivered')`, [OP, CONV, body])

const call = (name: string, args: unknown) => createToolBoundary(ctx).call(name, args)

describe('cancelling at the customer\'s word', () => {
  it('asks first: nothing is cancelled, and the policy and what was paid come back', async () => {
    const bookingId = await booked(true)
    await publish('cancellation', 'Cancelling more than 48 hours before the handover is free.')
    const result = await call('cancel_booking', { customerConfirmed: false })
    expect(result.status).toBe('ok')
    const data = (result as { data: { cancelled: boolean; guidance: string; policy: string } }).data
    expect(data.cancelled).toBe(false)
    expect(data.policy).toMatch(/48 hours/)
    expect(data.guidance).toMatch(/NOTHING HAS BEEN CANCELLED.*5 days and 22 hours from now.*paid AED 10,000/)
    const [b] = await run(`select state::text as state from bookings where id = $1`, [bookingId])
    expect(b!['state']).toBe('confirmed')
  })

  it('will not cancel on a yes to a question it never asked', async () => {
    await booked()
    await agentAsked('The Ferrari is all set for the 20th. Anything else?')
    expect(await call('cancel_booking', { customerConfirmed: true })).toMatchObject({ status: 'refused' })
  })

  it('cancels on their yes: car released, nothing left owed, and a refund put to a person', async () => {
    const bookingId = await booked(true)
    await agentAsked('Cancelling now is free under our policy. Shall I cancel it?')
    const result = await call('cancel_booking', { customerConfirmed: true })
    expect(result).toMatchObject({ status: 'ok', data: { cancelled: true } })
    expect(result.needsAPerson).toMatch(/paid AED 10,000: refund what the cancellation policy says/)
    expect(await run(`select state::text as state from bookings where id = $1`, [bookingId])).toEqual([{ state: 'cancelled' }])
    expect(await run(`select released_at is not null as released from vehicle_availability`, [])).toEqual([{ released: true }])
    expect(await run(`select kind::text as kind, state::text as state from payments order by kind::text desc`, []))
      .toEqual([{ kind: 'rental', state: 'paid' }, { kind: 'deposit', state: 'cancelled' }])
  })
})

describe('moving a booking to new dates', () => {
  it('prices the new dates and changes nothing until they agree', async () => {
    const bookingId = await booked()
    const result = await call('change_booking_dates', { newStartDate: '2026-09-25', newEndDate: '2026-09-28', customerConfirmed: false })
    expect(result).toMatchObject({ status: 'ok', data: { applied: false, total: 'AED 15,000', difference: 'AED 5,000 more' } })
    const [q] = await run(`select q.start_date::date::text as s from bookings b join quotes q on q.id = b.quote_id where b.id = $1`, [bookingId])
    expect(q!['s']).toBe('2026-09-20')
  })

  it('moves the booking, the calendar and what is owed on their yes', async () => {
    const bookingId = await booked()
    await agentAsked('Friday 25th to Monday 28th, 3 days, AED 15,000. Shall I move it?')
    const result = await call('change_booking_dates', { newStartDate: '2026-09-25', newEndDate: '2026-09-28', customerConfirmed: true })
    expect(result).toMatchObject({ status: 'ok', data: { applied: true } })
    const [q] = await run(`select q.start_date::date::text as s, q.total_minor from bookings b join quotes q on q.id = b.quote_id where b.id = $1`, [bookingId])
    expect(q).toEqual({ s: '2026-09-25', total_minor: 1500000 })
    expect(await run(`select start_date, end_date from vehicle_availability where booking_id = $1`, [bookingId]))
      .toEqual([{ start_date: '2026-09-25', end_date: '2026-09-28' }])
    expect(await run(`select amount_minor from payments where kind = 'rental'`, [])).toEqual([{ amount_minor: 1500000 }])
  })

  it('refuses dates the car is already booked for, and says until when', async () => {
    await booked()
    await run(`insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason, recorded_by)
               values ($1, $2, '2026-09-26', '2026-09-27', 'booked', 'someone else')`, [OP, CAR])
    const result = await call('change_booking_dates', { newStartDate: '2026-09-25', newEndDate: '2026-09-28', customerConfirmed: false })
    expect(result).toMatchObject({ status: 'refused' })
    expect((result as { detail: string }).detail).toMatch(/already booked from 2026-09-26 to 2026-09-27/)
  })

  it('will not apply dates it never put to them', async () => {
    await booked()
    await agentAsked('Shall I move it to the 30th?')
    expect(await call('change_booking_dates', { newStartDate: '2026-09-25', newEndDate: '2026-09-28', customerConfirmed: true }))
      .toMatchObject({ status: 'refused' })
  })
})
