import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  answerOperationsRequest, findCurrentAnswer, listOpenOperationsRequests, raiseOperationsRequest,
} from '../src/queries/operations.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let vehicleId: string

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, answer_valid_minutes)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', 240);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'operations');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Layla');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const [v] = await run(
    `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by)
     values ($1,'Ferrari','488',2022,'Giallo','exotic','Dubai K 1','VIN1',
             'operator_confirmed','Owner') returning id`,
    [OP],
  )
  vehicleId = v!['id'] as string
})

const ask = () =>
  raiseOperationsRequest(run, {
    operatorId: OP, conversationId: CONV, kind: 'availability',
    vehicleId, requestedVehicle: 'the yellow one',
    startDate: '2026-09-17', endDate: '2026-09-18',
  })

const answer = (
  requestId: string,
  a: 'available' | 'unavailable' | 'pending_confirmation' | 'unknown',
  checkedMinutesAgo = 0,
) =>
  answerOperationsRequest(run, {
    requestId, operatorId: OP, membershipId: SARA, answer: a,
    source: 'fleet calendar',
    checkedAt: new Date(Date.now() - checkedMinutesAgo * 60_000),
  })

const current = (start = '2026-09-17', end: string | null = '2026-09-18') =>
  findCurrentAnswer(run, { operatorId: OP, vehicleId, startDate: start, endDate: end })

describe('asking Operations', () => {
  it('keeps what the customer actually said, alongside the matched car', async () => {
    await ask()
    const [item] = await listOpenOperationsRequests(run, OP)
    // "the yellow one" is how the person checking knows they have the right car.
    expect(item).toMatchObject({
      requestedVehicle: 'the yellow one',
      vehicleLabel: 'Ferrari 488 · Giallo',
      customerName: 'Layla',
      startDate: '2026-09-17',
    })
  })

  it('asks once for the same car and dates', async () => {
    const first = await ask()
    const second = await ask()
    expect(second).toMatchObject({ requestId: first.requestId, alreadyOpen: true })
    expect(await listOpenOperationsRequests(run, OP)).toHaveLength(1)
  })
})

describe('using an answer', () => {
  it('carries the source and how long ago it was checked', async () => {
    const { requestId } = await ask()
    await answer(requestId!, 'available', 12)

    const found = (await current())!
    expect(found).toMatchObject({ answer: 'available', source: 'fleet calendar' })
    expect(found.checkedMinutesAgo).toBeGreaterThanOrEqual(11)
  })

  /** "An expired answer is rechecked before it is reused." */
  it('is unusable once it has expired', async () => {
    const { requestId } = await ask()
    // Checked five hours ago against a four-hour window.
    await answer(requestId!, 'available', 300)
    expect(await current()).toBeNull()
  })

  /**
   * "An answer without a time checked cannot be given to a customer." The
   * database refuses the row outright, so there is nothing for a read path to
   * be careful about.
   */
  it('cannot be recorded without a time checked and a source', async () => {
    const { requestId } = await ask()
    await expect(
      run(`update operations_requests set answer = 'available' where id = $1`, [requestId]),
    ).rejects.toThrow(/operations_requests_answer_is_checked/)
  })

  it('does not cover dates outside the window that was checked', async () => {
    const { requestId } = await ask()
    await answer(requestId!, 'available')
    // Checked 17-18. The 19th was never looked at.
    expect(await current('2026-09-19', '2026-09-19')).toBeNull()
    // And a window that starts inside but ends outside is not covered either.
    expect(await current('2026-09-17', '2026-09-20')).toBeNull()
  })

  it('leaves the queue once answered', async () => {
    const { requestId } = await ask()
    await answer(requestId!, 'unavailable')
    expect(await listOpenOperationsRequests(run, OP)).toHaveLength(0)
  })

  it('cannot be answered twice', async () => {
    const { requestId } = await ask()
    expect(await answer(requestId!, 'available')).toMatchObject({ answered: true })
    expect(await answer(requestId!, 'unavailable')).toMatchObject({ answered: false })
  })

  it('is invisible to another operator', async () => {
    const { requestId } = await ask()
    await answer(requestId!, 'available')
    const other = await findCurrentAnswer(run, {
      operatorId: '22222222-2222-2222-2222-222222222222',
      vehicleId, startDate: '2026-09-17', endDate: '2026-09-18',
    })
    expect(other).toBeNull()
  })
})
