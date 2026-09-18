import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countExpiredConversations, purgeExpiredConversations,
} from '../src/queries/retention.ts'
import type { QueryRunner } from '../src/runner.ts'

/**
 * `retention_days` sits on the settings page saying "Conversations, contacts
 * and anything a customer sent. Shorter is kinder and harder to undo." It is
 * validated, stored and audited, and nothing had ever deleted a row. An
 * operator setting ninety days believed their customers' messages were gone
 * after ninety days; every one of them was still there.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'

let db: PGlite
let run: QueryRunner
let nth = 0

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, retention_days) values ('${OP}', 'Vyra Pilot', 90);
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Ahmed');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
  `)
  nth = 0
})

/** A conversation whose last message is `daysAgo` old. */
const conversation = async (daysAgo: number) => {
  nth += 1
  const [c] = await run(
    `insert into contacts (operator_id, channel_identifier) values ($1, $2) returning id`,
    [OP, `9715500${String(nth).padStart(4, '0')}`],
  )
  const [v] = await run(
    `insert into conversations (operator_id, contact_id, whatsapp_account_id) values ($1,$2,$3)
     returning id`,
    [OP, c!['id'], ACCOUNT],
  )
  await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                           created_at)
     values ($1, $2, 'inbound', 'text', 'is the Ferrari free', $3,
             now() - make_interval(days => $4::int))`,
    [OP, v!['id'], `wamid.${nth}`, daysAgo],
  )
  return { conversationId: v!['id'] as string, contactId: c!['id'] as string }
}

describe('deleting what the operator said to delete', () => {
  it('removes a conversation past the retention period', async () => {
    await conversation(120)
    expect(await purgeExpiredConversations(run))
      .toMatchObject({ conversations: 1, messages: 1, contacts: 1 })
    expect(await run(`select id from conversations`, [])).toEqual([])
    expect(await run(`select id from messages`, [])).toEqual([])
  })

  it('leaves one inside the period alone', async () => {
    await conversation(30)
    expect(await purgeExpiredConversations(run)).toMatchObject({ conversations: 0 })
    expect(await run(`select id from conversations`, [])).toHaveLength(1)
  })

  /** Measured from the last thing that happened, not from when it opened. */
  it('keeps a long thread alive on its most recent message', async () => {
    const { conversationId } = await conversation(400)
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', 'still interested', 'wamid.recent')`,
      [OP, conversationId],
    )
    expect(await purgeExpiredConversations(run)).toMatchObject({ conversations: 0 })
  })

  /**
   * A quote is the operator's record of a price they offered. A setting on a
   * sales screen does not get to bin one.
   */
  it('will not delete a conversation that became business', async () => {
    const { conversationId } = await conversation(400)
    await run(
      `insert into quotes (operator_id, conversation_id, revision, state, total_minor, lines)
       values ($1, $2, 1, 'draft', 500000, '[]'::jsonb)`,
      [OP, conversationId],
    )
    expect(await purgeExpiredConversations(run)).toMatchObject({ conversations: 0 })
    expect(await run(`select id from conversations`, [])).toHaveLength(1)
  })

  it('takes everything hanging off the conversation with it', async () => {
    const { conversationId } = await conversation(120)
    const [e] = await run(
      `insert into enquiries (operator_id, conversation_id) values ($1,$2) returning id`,
      [OP, conversationId],
    )
    await run(
      `insert into field_evidence (operator_id, enquiry_id, field, value)
       values ($1, $2, 'vehicle', 'Ferrari 488 Spider')`,
      [OP, e!['id']],
    )
    await run(
      `insert into conversation_notes (operator_id, conversation_id, author_membership_id, body)
       values ($1, $2, $3, 'called them')`,
      [OP, conversationId, MEMBER],
    )

    await purgeExpiredConversations(run)
    expect(await run(`select id from field_evidence`, [])).toEqual([])
    expect(await run(`select id from enquiries`, [])).toEqual([])
    expect(await run(`select id from conversation_notes`, [])).toEqual([])
  })

  /**
   * A number outliving every conversation it belonged to is the part of this
   * that is personal data rather than business record.
   *
   * `conversations_operator_contact_key` makes the relationship one to one, so
   * in practice deleting a conversation always orphans its contact. The guard
   * in the query is kept anyway: it costs nothing and it is the constraint
   * that makes it true, not this function.
   */
  it('takes the phone number with the last conversation it belonged to', async () => {
    await conversation(120)
    expect(await purgeExpiredConversations(run)).toMatchObject({ contacts: 1 })
    expect(await run(`select id from contacts`, [])).toEqual([])
  })

  it('leaves the contact alone when the conversation stays', async () => {
    await conversation(30)
    expect(await purgeExpiredConversations(run)).toMatchObject({ contacts: 0 })
    expect(await run(`select id from contacts`, [])).toHaveLength(1)
  })

  it('works in batches rather than all at once', async () => {
    await conversation(120)
    await conversation(120)
    await conversation(120)
    expect(await purgeExpiredConversations(run, { limit: 2 }))
      .toMatchObject({ conversations: 2 })
    expect(await run(`select id from conversations`, [])).toHaveLength(1)
  })
})

/**
 * "Shorter is kinder and harder to undo" is a sentence somebody should be able
 * to check before they find out whether it was true.
 */
describe('what would go, without going', () => {
  it('counts them and leaves them alone', async () => {
    await conversation(120)
    await conversation(30)
    expect(await countExpiredConversations(run, OP)).toMatchObject({ expired: 1 })
    expect(await run(`select id from conversations`, [])).toHaveLength(2)
  })

  it('says separately how many are kept as records', async () => {
    const { conversationId } = await conversation(400)
    await run(
      `insert into quotes (operator_id, conversation_id, revision, state, total_minor, lines)
       values ($1, $2, 1, 'draft', 500000, '[]'::jsonb)`,
      [OP, conversationId],
    )
    expect(await countExpiredConversations(run, OP))
      .toMatchObject({ expired: 0, keptAsRecords: 1 })
  })
})
