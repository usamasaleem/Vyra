import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { queueOutboundText } from '../../db/src/queries/outbound.ts'
import type { QueryRunner } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)),'..','..','db','migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const OTHER_OPERATOR = '22222222-2222-2222-2222-222222222222'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'
const MEMBERSHIP = '88888888-8888-8888-8888-888888888888'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot'), ('${OTHER_OPERATOR}', 'Rival');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id, revision)
    values ('${CONVERSATION}', '${OPERATOR}', '55555555-5555-5555-5555-555555555555',
            '33333333-3333-3333-3333-333333333333', 7);
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBERSHIP}', '${OPERATOR}', '99999999-9999-9999-9999-999999999999', 'salesperson');
  `)
})

const queue = (over: Record<string, unknown> = {}) =>
  queueOutboundText(run, {
    conversationId: CONVERSATION, operatorId: OPERATOR,
    body: 'Our Ferrari 296 is available Friday to Sunday.',
    idempotencyKey: 'turn-1', ...over,
  })

describe('queueing an outbound message', () => {
  it('creates the message and its dispatch job together', async () => {
    const result = await queue()
    expect(result.duplicate).toBe(false)
    expect(result.messageId).toBeTruthy()
    expect(result.outboxId).toBeTruthy()

    const jobs = await run(`select event_type, aggregate_id from outbox`, [])
    expect(jobs[0]).toMatchObject({ event_type: 'dispatch_outbound', aggregate_id: result.messageId })
  })

  it('binds AI output to the conversation revision', async () => {
    const { messageId } = await queue()
    const rows = await run('select revision_at_send, sent_by_membership_id from messages where id = $1', [messageId])
    expect(rows[0]).toMatchObject({ revision_at_send: 7, sent_by_membership_id: null })
  })

  /** A salesperson means what they typed regardless of later state changes. */
  it('does not bind a salesperson message to a revision', async () => {
    const { messageId } = await queue({ idempotencyKey: 'staff-1', sentByMembershipId: MEMBERSHIP })
    const rows = await run('select revision_at_send, sent_by_membership_id from messages where id = $1', [messageId])
    expect(rows[0]).toMatchObject({ revision_at_send: null, sent_by_membership_id: MEMBERSHIP })
  })

  it('queues one logical reply once', async () => {
    const first = await queue()
    const second = await queue()

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.outboxId).toBeNull()

    const messageCount = (await run('select count(*)::int as n from messages', []))[0]!.n
    expect(messageCount).toBe(1)
    const jobCount = (await run('select count(*)::int as j from outbox', []))[0]!.j
    expect(jobCount).toBe(1)
  })

  it('writes nothing for a conversation belonging to another operator', async () => {
    const result = await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OTHER_OPERATOR,
      body: 'leak attempt', idempotencyKey: 'leak-1',
    })
    expect(result.messageId).toBeNull()
    const messageCount = (await run('select count(*)::int as n from messages', []))[0]!.n
    expect(messageCount).toBe(0)
  })
})
