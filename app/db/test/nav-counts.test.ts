import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { getNavCounts } from '../src/queries/nav-counts.ts'
import { acceptHandoff, raiseHandoff, resolveHandoff } from '../src/queries/handoff-queue.ts'
import { answerOperationsRequest, raiseOperationsRequest } from '../src/queries/operations.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const OTHER_OP = '11111111-1111-1111-1111-1111111111bb'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
// A second contact, because one contact holds at most one conversation per
// operator — the schema says so, and the first version of this fixture found out.
const CONTACT_B = '55555555-5555-5555-5555-5555555555bb'
const CONV = '66666666-6666-6666-6666-666666666666'
const CONV_B = '66666666-6666-6666-6666-6666666666bb'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, handoff_sla_minutes, answer_valid_minutes) values
      ('${OP}', 'Vyra Pilot', 'Asia/Dubai', 30, 240),
      ('${OTHER_OP}', 'Someone Else', 'Asia/Dubai', 30, 240);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier, display_name) values
      ('${CONTACT}', '${OP}', '971500000001', 'Layla'),
      ('${CONTACT_B}', '${OP}', '971500000002', 'Omar');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id) values
      ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}'),
      ('${CONV_B}', '${OP}', '${CONTACT_B}', '${ACCOUNT}');
  `)
})

const raise = (conversationId = CONV) =>
  raiseHandoff(run, {
    operatorId: OP, conversationId, reason: 'customer_asked',
    summary: 'Customer asked to speak to someone.',
  })

const ask = (conversationId = CONV) =>
  raiseOperationsRequest(run, {
    operatorId: OP, conversationId, kind: 'availability',
    vehicleId: null, requestedVehicle: 'Ferrari 488',
    startDate: '2026-10-01', endDate: '2026-10-03',
  })

describe('getNavCounts', () => {
  it('is zero for an operator with nothing waiting', async () => {
    expect(await getNavCounts(run, OP)).toEqual({
      unclaimedHandoffs: 0,
      openOperationsRequests: 0,
      customersWaiting: 0,
    })
  })

  it('counts unclaimed handoffs and open requests', async () => {
    await raise()
    await raise(CONV_B)
    await ask()

    expect(await getNavCounts(run, OP)).toEqual({
      unclaimedHandoffs: 2,
      openOperationsRequests: 1,
      customersWaiting: 0,
    })
  })

  /**
   * The badge exists to show what nobody is holding. A handoff somebody has
   * accepted is still open work, but it is not waiting on the room — counting
   * it would keep a number on screen that no one can act on, which is how a
   * badge stops being read.
   */
  it('stops counting a handoff once somebody accepts it', async () => {
    const { handoffId } = await raise()
    expect(handoffId).not.toBeNull()
    expect((await getNavCounts(run, OP)).unclaimedHandoffs).toBe(1)

    await acceptHandoff(run, { operatorId: OP, handoffId: handoffId!, membershipId: SARA })
    expect((await getNavCounts(run, OP)).unclaimedHandoffs).toBe(0)
  })

  it('stops counting a resolved handoff', async () => {
    await raise()
    await resolveHandoff(run, { operatorId: OP, conversationId: CONV, resolution: 'handled' })
    expect((await getNavCounts(run, OP)).unclaimedHandoffs).toBe(0)
  })

  it('stops counting a request once it is answered', async () => {
    const { requestId } = await ask()
    expect(requestId).not.toBeNull()
    expect((await getNavCounts(run, OP)).openOperationsRequests).toBe(1)

    await answerOperationsRequest(run, {
      operatorId: OP, requestId: requestId!, membershipId: SARA,
      answer: 'available', source: 'fleet calendar',
    })
    expect((await getNavCounts(run, OP)).openOperationsRequests).toBe(0)
  })

  /**
   * The counts are read straight from the nav on every page, so a missing
   * operator filter here would put one operator's queue depth in front of
   * another's staff.
   */
  /**
   * The one nobody was counting. A conversation a person owns whose last
   * message is the customer's is a customer being kept waiting, and it looked
   * like a bug in the agent three times before anything counted it.
   */
  it('counts a customer left waiting on a person', async () => {
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', 'any update?', 'wamid.waiting')`,
      [OP, CONV],
    )

    expect((await getNavCounts(run, OP)).customersWaiting).toBe(1)
  })

  it('stops counting a waiting customer once somebody replies', async () => {
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, created_at)
       values ($1, $2, 'inbound', 'text', 'any update?', 'wamid.w1', now() - interval '5 minutes')`,
      [OP, CONV],
    )
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'outbound', 'text', 'Here you go.', 'wamid.w2')`,
      [OP, CONV],
    )

    expect((await getNavCounts(run, OP)).customersWaiting).toBe(0)
  })

  it('counts nothing for an operator that owns none of it', async () => {
    await raise()
    await ask()

    expect(await getNavCounts(run, OTHER_OP)).toEqual({
      unclaimedHandoffs: 0,
      openOperationsRequests: 0,
      customersWaiting: 0,
    })
  })
})
