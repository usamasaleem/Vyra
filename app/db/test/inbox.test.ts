import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { setOperatorAiSending, getOperatorStatus } from '../src/queries/operator-controls.ts'
import { queueOutboundText } from '../src/queries/outbound.ts'
import { resumeAi, takeOverConversation } from '../src/queries/takeover.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'
const MEMBERSHIP = '88888888-8888-8888-8888-888888888888'

let db: PGlite
let run: QueryRunner

const conversationState = async () =>
  (await run('select handler_mode, owner_membership_id, revision from conversations where id = $1', [CONVERSATION]))[0]!

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot'), ('${RIVAL}', 'Rival Rentals');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id, last_customer_message_at)
    values ('${CONVERSATION}', '${OPERATOR}', '55555555-5555-5555-5555-555555555555',
            '33333333-3333-3333-3333-333333333333', now());
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBERSHIP}', '${OPERATOR}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Ahmed');
  `)
})

describe('taking over a conversation', () => {
  it('assigns the owner, flips the mode and bumps the revision at once', async () => {
    const result = await takeOverConversation(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP,
    })
    expect(result).toMatchObject({ taken: true, revision: 1, cancelledDrafts: 0 })
    expect(await conversationState()).toMatchObject({
      handler_mode: 'human', owner_membership_id: MEMBERSHIP, revision: 1,
    })
  })

  /** The guarantee takeover exists for. */
  it('cancels AI drafts that have not been sent', async () => {
    const draft = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'AI draft', idempotencyKey: 'turn-1',
    })
    const result = await takeOverConversation(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP,
    })

    expect(result.cancelledDrafts).toBe(1)
    const row = (await run('select delivery_state, error_code from messages where id = $1', [draft.messageId]))[0]!
    expect(row).toMatchObject({ delivery_state: 'cancelled', error_code: 'conversation_taken_over' })
  })

  /** A salesperson's own queued message is theirs, and still stands. */
  it('leaves a salesperson queued message alone', async () => {
    const staff = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'From a person', idempotencyKey: 'staff-1', sentByMembershipId: MEMBERSHIP,
    })
    const result = await takeOverConversation(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP,
    })

    expect(result.cancelledDrafts).toBe(0)
    const row = (await run('select delivery_state from messages where id = $1', [staff.messageId]))[0]!
    expect(row['delivery_state']).toBe('pending')
  })

  it('does not touch an already-sent message', async () => {
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state, provider_id)
       values ($1, $2, 'outbound', 'text', 'already gone', 'delivered', 'wamid.GONE')`,
      [OPERATOR, CONVERSATION],
    )
    await takeOverConversation(run, { conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP })
    const row = (await run(`select delivery_state from messages where provider_id = 'wamid.GONE'`, []))[0]!
    expect(row['delivery_state']).toBe('delivered')
  })

  it('records an audit event bound to the new revision', async () => {
    await takeOverConversation(run, { conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP })
    const rows = await run(`select action, subject_version, actor_id, actor_type from audit_events`, [])
    expect(rows[0]).toMatchObject({
      action: 'conversation.takeover', subject_version: 1,
      actor_id: MEMBERSHIP, actor_type: 'user',
    })
  })

  it('refuses a conversation belonging to another operator', async () => {
    const result = await takeOverConversation(run, {
      conversationId: CONVERSATION, operatorId: RIVAL, membershipId: MEMBERSHIP,
    })
    expect(result.taken).toBe(false)
    expect((await conversationState())['handler_mode']).toBe('ai')
  })
})

describe('handing back to the AI', () => {
  it('requires the conversation to be human-owned', async () => {
    expect(await resumeAi(run, { conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP }))
      .toEqual({ resumed: false, revision: null })
  })

  it('clears the owner and bumps the revision again', async () => {
    await takeOverConversation(run, { conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP })
    const result = await resumeAi(run, { conversationId: CONVERSATION, operatorId: OPERATOR, membershipId: MEMBERSHIP })

    expect(result).toEqual({ resumed: true, revision: 2 })
    expect(await conversationState()).toMatchObject({
      handler_mode: 'ai', owner_membership_id: null, revision: 2,
    })
  })
})

describe('the AI kill switch', () => {
  it('starts off, because shadow mode comes first', async () => {
    expect((await getOperatorStatus(run, OPERATOR))!.aiSendingEnabled).toBe(false)
  })

  it('turns on and off, recording who did it', async () => {
    expect(await setOperatorAiSending(run, { operatorId: OPERATOR, enabled: true, membershipId: MEMBERSHIP }))
      .toEqual({ changed: true, aiSendingEnabled: true })
    expect((await getOperatorStatus(run, OPERATOR))!.aiSendingEnabled).toBe(true)

    await setOperatorAiSending(run, { operatorId: OPERATOR, enabled: false, membershipId: MEMBERSHIP })
    expect((await getOperatorStatus(run, OPERATOR))!.aiSendingEnabled).toBe(false)

    const actions = (await run('select action from audit_events order by created_at', [])).map((r) => r['action'])
    expect(actions).toEqual(['operator.ai_enabled', 'operator.ai_disabled'])
  })

  /** Pausing the AI must not stop messages arriving or staff replying. */
  it('does not block staff replies', async () => {
    await setOperatorAiSending(run, { operatorId: OPERATOR, enabled: false, membershipId: MEMBERSHIP })
    const result = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'A person is replying', idempotencyKey: 'staff-while-paused',
      sentByMembershipId: MEMBERSHIP,
    })
    expect(result.messageId).toBeTruthy()
  })
})


/**
 * Several photographs arriving over five seconds feel slower than the same
 * photographs over half of one, and the gap was queue latency rather than
 * anything Meta does. One job sends them back to back.
 */
describe('sending several messages from one job', () => {
  it('gives a follow-up no job of its own', async () => {
    const extra = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: ' ', replyImageUrl: 'https://example.com/side.jpg',
      idempotencyKey: 'turn-x:photo:1', withoutOwnJob: true,
    })

    expect(extra.messageId).not.toBeNull()
    // The message exists; nothing is scheduled to send it on its own.
    expect(extra.outboxId).toBeNull()
  })

  it('names the follow-ups on the job that will send them', async () => {
    const extra = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: ' ', replyImageUrl: 'https://example.com/side.jpg',
      idempotencyKey: 'turn-y:photo:1', withoutOwnJob: true,
    })
    const reply = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'Here she is.', idempotencyKey: 'turn-y',
      replyImageUrl: 'https://example.com/front.jpg',
      alsoSend: [extra.messageId!],
    })

    const [job] = await run(
      `select payload from outbox where aggregate_id = $1`, [reply.messageId],
    )
    const payload = job!['payload'] as { message_id: string; also_message_ids: string[] }
    expect(payload.message_id).toBe(reply.messageId)
    // Order is the payload's, not the queue's: the reply carries the caption
    // and must arrive first.
    expect(payload.also_message_ids).toEqual([extra.messageId])
  })

  it('carries an empty list when a reply travels alone', async () => {
    const reply = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'Just words.', idempotencyKey: 'turn-z',
    })

    const [job] = await run(
      `select payload from outbox where aggregate_id = $1`, [reply.messageId],
    )
    expect((job!['payload'] as { also_message_ids: string[] }).also_message_ids).toEqual([])
  })
})
