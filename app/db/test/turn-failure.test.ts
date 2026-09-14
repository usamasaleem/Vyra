import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordTurnFailure } from '../src/queries/turn-failure.ts'
import { queueOutboundText } from '../src/queries/outbound.ts'
import { takeOverConversation } from '../src/queries/takeover.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let messageId: string

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', 'how much for the Ferrari?', 'wamid.1') returning id`,
    [OP, CONV],
  )
  messageId = rows[0]!['id'] as string
})

const fail = (kind: Parameters<typeof recordTurnFailure>[1]['kind'], detail = 'something broke') =>
  recordTurnFailure(run, { conversationId: CONV, operatorId: OP, kind, detail, messageId })

describe('a failed turn becomes visible', () => {
  it('puts the conversation in front of a person, with what to do', async () => {
    expect(await fail('provider_error', '503 upstream unavailable')).toMatchObject({ raised: true })

    const [conversation] = await run(
      `select handler_mode::text as mode, priority::text as priority, next_action
       from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({
      mode: 'human',
      priority: 'high',
      next_action: 'AI unavailable — reply manually',
    })
  })

  it('says what actually went wrong, where a person can find it later', async () => {
    await fail('tool_budget_exhausted', 'spent its tool budget after 8 calls without replying')
    const [audit] = await run(
      `select action, actor_type::text as actor, data from audit_events where subject_id = $1`, [CONV],
    )
    expect(audit).toMatchObject({ action: 'turn.failed', actor: 'ai' })
    const data = audit!['data'] as Record<string, unknown>
    expect(data).toMatchObject({ kind: 'tool_budget_exhausted', message_id: messageId })
  })

  /**
   * Separate from conversation.handoff_requested on purpose. "The AI asked for
   * help" and "the AI broke" are opposite signals about a pilot, and step 32
   * has to be able to count them apart.
   */
  it('is not recorded as the model asking for help', async () => {
    await fail('no_output')
    const actions = await run(`select action from audit_events where subject_id = $1`, [CONV])
    expect(actions.map((a) => a['action'])).toEqual(['turn.failed'])
  })

  it('stops a draft from an earlier turn landing after the handover', async () => {
    const draft = await queueOutboundText(run, {
      conversationId: CONV, operatorId: OP, body: 'Half-finished thought', idempotencyKey: 'turn:0',
    })
    expect(await fail('timeout')).toMatchObject({ cancelledDrafts: 1 })

    const [message] = await run(
      `select delivery_state::text as state, error_code from messages where id = $1`, [draft.messageId],
    )
    expect(message).toMatchObject({ state: 'cancelled', error_code: 'turn_failed' })
  })
})

describe('priority', () => {
  it('raises an ordinary conversation, because the customer has no reply at all', async () => {
    await fail('no_output')
    const [row] = await run(`select priority::text as priority from conversations where id = $1`, [CONV])
    expect(row).toMatchObject({ priority: 'high' })
  })

  /** Something set urgent for a better reason than this — an accident report. */
  it('never downgrades one that is already urgent', async () => {
    await run(`update conversations set priority = 'urgent' where id = $1`, [CONV])
    await fail('provider_error')
    const [row] = await run(`select priority::text as priority from conversations where id = $1`, [CONV])
    expect(row).toMatchObject({ priority: 'urgent' })
  })
})

describe('repeats', () => {
  it('a retried job that fails the same way does not raise a second task', async () => {
    await fail('provider_error')
    const second = await fail('provider_error')

    expect(second).toMatchObject({ raised: false, alreadyWithAPerson: true })
    const [row] = await run(`select revision from conversations where id = $1`, [CONV])
    expect(Number(row!['revision'])).toBe(1)
    expect(await run(`select id from audit_events where subject_id = $1`, [CONV])).toHaveLength(1)
  })

  it('does nothing when a salesperson already has it', async () => {
    await takeOverConversation(run, { conversationId: CONV, operatorId: OP, membershipId: MEMBER })
    const result = await fail('timeout')

    expect(result).toMatchObject({ raised: false, alreadyWithAPerson: true })
    // Their own next action is not overwritten by a machine's.
    const [row] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(row!['next_action']).toBeNull()
  })
})
