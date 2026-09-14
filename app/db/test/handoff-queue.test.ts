import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acceptHandoff, escalateOverdueHandoffs, raiseHandoff, resolveHandoff,
} from '../src/queries/handoff-queue.ts'
import { assembleHandoffPacket } from '../src/queries/handoff-packet.ts'
import { ensureEnquiry, recordFields } from '../src/queries/enquiry-fields.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const OMAR = '44444444-4444-4444-4444-4444444444bb'
const MANAGER = '44444444-4444-4444-4444-4444444444cc'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

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
    insert into operators (id, name, timezone, handoff_sla_minutes)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', 30);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role) values
      ('${SARA}',    '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson'),
      ('${OMAR}',    '${OP}', '10000000-0000-0000-0000-000000000002', 'salesperson'),
      ('${MANAGER}', '${OP}', '10000000-0000-0000-0000-000000000003', 'manager');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Layla');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const raise = (reason: Parameters<typeof raiseHandoff>[1]['reason'] = 'customer_asked') =>
  raiseHandoff(run, {
    operatorId: OP, conversationId: CONV, reason,
    summary: 'Customer asked to speak to someone about a Ferrari.',
  })

describe('raising a handoff', () => {
  it('gives it a clock from the operator own SLA', async () => {
    const result = await raise()
    expect(result.handoffId).not.toBeNull()

    const [row] = await run(
      `select state::text as state, due_at,
              extract(epoch from due_at - now())::int as seconds_left
       from handoffs where id = $1`, [result.handoffId],
    )
    expect(row).toMatchObject({ state: 'waiting' })
    // 30 minutes, from operators.handoff_sla_minutes, not a number chosen here.
    expect(Number(row!['seconds_left'])).toBeGreaterThan(29 * 60)
  })

  /**
   * Section 18.11's "done when": an unaccepted handoff reaches the fallback
   * without duplicate replies. Two messages in a burst must not raise two
   * tasks — a salesperson would accept one while the other escalated behind
   * them.
   */
  it('does not raise a second task for the same conversation', async () => {
    const first = await raise()
    const second = await raise('qualified_lead')

    expect(second).toMatchObject({ handoffId: null, alreadyOpen: true })
    const rows = await run(`select id from handoffs where conversation_id = $1`, [CONV])
    expect(rows).toHaveLength(1)
    expect(rows[0]!['id']).toBe(first.handoffId)
  })

  it('allows a new one once the last was resolved', async () => {
    await raise()
    await resolveHandoff(run, { conversationId: CONV, operatorId: OP, resolution: 'handled' })
    const again = await raise('discount_requested')
    expect(again.handoffId).not.toBeNull()
  })

  /** Urgency is a policy judgement, not something a model ranks about itself. */
  it.each([
    ['safety_or_accident', 'urgent'],
    ['payment_or_dispute', 'urgent'],
    ['customer_asked', 'high'],
    ['qualified_lead', 'normal'],
  ] as const)('rates %s as %s', async (reason, expected) => {
    const result = await raiseHandoff(run, {
      operatorId: OP, conversationId: CONV, reason, summary: 'x',
    })
    expect(result.priority).toBe(expected)
  })
})

describe('accepting', () => {
  it('gives the conversation to whoever took the task', async () => {
    const { handoffId } = await raise()
    const result = await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: SARA })
    expect(result).toMatchObject({ accepted: true, takenBy: SARA })

    const [conversation] = await run(
      `select owner_membership_id from conversations where id = $1`, [CONV],
    )
    // A task accepted by someone who does not own the conversation is a task
    // with no authority behind it.
    expect(conversation).toMatchObject({ owner_membership_id: SARA })
  })

  it('lets only one person take it', async () => {
    const { handoffId } = await raise()
    const sara = await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: SARA })
    const omar = await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: OMAR })

    expect(sara.accepted).toBe(true)
    expect(omar).toMatchObject({ accepted: false, takenBy: SARA })
  })
})

describe('when nobody accepts', () => {
  const makeOverdue = () =>
    run(`update handoffs set due_at = now() - interval '5 minutes' where conversation_id = $1`, [CONV])

  it('escalates and names the fallback owner', async () => {
    await run(`update operators set fallback_owner_membership_id = $1 where id = $2`, [MANAGER, OP])
    await raise()
    await makeOverdue()

    const escalated = await escalateOverdueHandoffs(run)
    expect(escalated).toHaveLength(1)
    expect(escalated[0]).toMatchObject({
      fallbackOwnerMembershipId: MANAGER,
      reason: 'customer_asked',
    })
    expect(escalated[0]!.minutesLate).toBeGreaterThanOrEqual(5)
  })

  /**
   * Escalating marks and alerts; it does not reassign. Silently handing it to
   * one person removes it from everyone else's view, which is the same failure
   * as nobody seeing it with an extra step.
   */
  it('keeps the queue item visible rather than reassigning it', async () => {
    await raise()
    await makeOverdue()
    await escalateOverdueHandoffs(run)

    const [row] = await run(
      `select state::text as state, owner_membership_id, escalated_at from handoffs where conversation_id = $1`,
      [CONV],
    )
    expect(row).toMatchObject({ state: 'escalated', owner_membership_id: null })
    expect(row!['escalated_at']).not.toBeNull()
  })

  it('escalates only once', async () => {
    await raise()
    await makeOverdue()
    expect(await escalateOverdueHandoffs(run)).toHaveLength(1)
    expect(await escalateOverdueHandoffs(run)).toHaveLength(0)
  })

  it('never escalates one someone already accepted', async () => {
    const { handoffId } = await raise()
    await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: SARA })
    await makeOverdue()
    expect(await escalateOverdueHandoffs(run)).toHaveLength(0)
  })

  /**
   * An operator who never named a fallback owner should find out from a warning
   * rather than from a customer who waited all night, so this reports rather
   * than skipping.
   */
  it('still reports when no fallback owner is configured', async () => {
    await raise()
    await makeOverdue()
    const escalated = await escalateOverdueHandoffs(run)
    expect(escalated).toHaveLength(1)
    expect(escalated[0]!.fallbackOwnerMembershipId).toBeNull()
  })

  it('can still be accepted after escalating', async () => {
    const { handoffId } = await raise()
    await makeOverdue()
    await escalateOverdueHandoffs(run)
    const result = await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: OMAR })
    expect(result).toMatchObject({ accepted: true })
  })
})

describe('the packet', () => {
  it('carries the evidence behind every fact, not just the fact', async () => {
    const enquiryId = (await ensureEnquiry(run, OP, CONV))!
    const [msg] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body)
       values ($1, $2, 'inbound', 'text', 'I want a ferrari on friday') returning id`,
      [OP, CONV],
    )
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari 488', originalWording: 'a ferrari',
          sourceMessageId: msg!['id'] as string, verificationState: 'customer_stated' },
      ],
    })
    await raise('qualified_lead')

    const packet = (await assembleHandoffPacket(run, OP, CONV))!
    expect(packet.customer).toMatchObject({ name: 'Layla', whatsappNumber: '971500000001' })
    expect(packet.known[0]).toMatchObject({
      field: 'vehicle', value: 'Ferrari 488', saidAs: 'a ferrari', basis: 'customer_stated',
    })
    // What a salesperson still has to ask, so they ask rather than guess.
    expect(packet.unresolved).toContain('start_at')
    expect(packet.transcript[0]).toMatchObject({ from: 'customer' })
  })

  /**
   * A cancelled draft was never seen by the customer. Showing it would have a
   * salesperson refer to something that was never said.
   */
  it('leaves out messages the customer never received', async () => {
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state)
       values ($1, $2, 'outbound', 'text', 'A draft nobody sent', 'cancelled'),
              ($1, $2, 'outbound', 'text', 'This one went', 'read')`,
      [OP, CONV],
    )
    const packet = (await assembleHandoffPacket(run, OP, CONV))!
    const texts = packet.transcript.map((t) => t.text)
    expect(texts).toContain('This one went')
    expect(texts).not.toContain('A draft nobody sent')
  })

  it('is not found for another operator', async () => {
    await raise()
    expect(await assembleHandoffPacket(run, '22222222-2222-2222-2222-222222222222', CONV)).toBeNull()
  })
})
