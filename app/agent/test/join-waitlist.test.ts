import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createToolBoundary } from '../src/tools/boundary.ts'
import type { ToolContext } from '../src/tools/context.ts'
import { ensureEnquiry } from '../../db/src/queries/enquiry-fields.ts'
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

const CAR = '77777777-7777-7777-7777-777777777777'
const OTHER_CONTACT = '55555555-5555-5555-5555-5555555555bb'
const OTHER_CONV = '66666666-6666-6666-6666-6666666666bb'

/** The Ferrari, booked by somebody else from the 20th to the 22nd. */
async function takenBySomebodyElse() {
  await db.exec(`
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category, plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic', 'D 9', 'V9', 'operator_confirmed', 'Owner');
    insert into contacts (id, operator_id, channel_identifier) values ('${OTHER_CONTACT}', '${OP}', '971500000002');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${OTHER_CONV}', '${OP}', '${OTHER_CONTACT}', '${ACCOUNT}');
  `)
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, vehicle_id, revision, state, total_minor, lines, start_date, end_date, days,
                         approved_by_membership_id, approved_at)
     values ($1, $2, $3, 1, 'sent', 1000000, '[]'::jsonb, '2026-09-20', '2026-09-22', 2, $4, now()) returning id`, [OP, OTHER_CONV, CAR, MEMBER])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, quote_id, state, decided_at)
     values ($1, $2, $3, 'confirmed', now()) returning id`, [OP, OTHER_CONV, q!['id']])
  await run(
    `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason, recorded_by, booking_id)
     values ($1, $2, '2026-09-20', '2026-09-22', 'booked', 'test', $3)`, [OP, CAR, b!['id']])
}

const call = (name: string, args: unknown) => createToolBoundary(ctx).call(name, args)
const waiting = () => run(`select conversation_id, vehicle_id, start_date, end_date from waitlist_entries where closed_at is null`, [])

describe('joining the waitlist', () => {
  it('puts them on the list for a car somebody else has booked, once however often they ask', async () => {
    await takenBySomebodyElse()
    const args = { vehicle: 'Ferrari 488', startDate: '2026-09-21', endDate: '2026-09-23' }
    const result = await call('join_waitlist', args)
    expect(result).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(result)).toMatch(/ON THE LIST/)
    expect(await call('join_waitlist', args)).toMatchObject({ status: 'ok' })
    expect(await waiting()).toEqual([{ conversation_id: CONV, vehicle_id: CAR, start_date: '2026-09-21', end_date: '2026-09-23' }])
  })

  it('refuses a car nothing is booked against: there is nothing a message could wait for', async () => {
    await takenBySomebodyElse()
    const result = await call('join_waitlist', { vehicle: 'Ferrari 488', startDate: '2026-09-25', endDate: '2026-09-26' })
    expect(result).toMatchObject({ status: 'refused', reason: 'nothing_to_do' })
    expect(await waiting()).toEqual([])
  })

  it('refuses dates in the past and a car that is not in the fleet', async () => {
    await takenBySomebodyElse()
    expect(await call('join_waitlist', { vehicle: 'Ferrari 488', startDate: '2026-09-10', endDate: '2026-09-12' }))
      .toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
    expect(await call('join_waitlist', { vehicle: 'Bugatti Chiron', startDate: '2026-09-21', endDate: '2026-09-23' }))
      .toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })
})
