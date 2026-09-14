import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadMessagesBeforeWindow, saveConversationSummary } from '../src/queries/summary.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

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
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const addMessages = async (n: number, prefix = 'message') => {
  for (let i = 0; i < n; i++) {
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, $3, 'text', $4, $5)`,
      [OP, CONV, i % 2 === 0 ? 'inbound' : 'outbound', `${prefix} ${i}`, `wamid.${prefix}.${i}`],
    )
  }
}

describe('loadMessagesBeforeWindow', () => {
  it('returns nothing while the whole conversation still fits', async () => {
    await addMessages(12)
    const result = await loadMessagesBeforeWindow(run, {
      conversationId: CONV, operatorId: OP, windowSize: 20,
    })
    expect(result).toMatchObject({ messages: [], totalMessages: 12 })
  })

  /**
   * The boundary that matters. At twenty-one messages the first one is no
   * longer in front of the model, and until now nothing else held it.
   */
  it('returns only what has fallen out of the window', async () => {
    await addMessages(25)
    const result = await loadMessagesBeforeWindow(run, {
      conversationId: CONV, operatorId: OP, windowSize: 20,
    })

    expect(result.totalMessages).toBe(25)
    expect(result.messages).toHaveLength(5)
    // Oldest first, and only the five the window no longer covers.
    expect(result.messages[0]!.body).toBe('message 0')
    expect(result.messages[4]!.body).toBe('message 4')
  })

  /**
   * A very long conversation must not produce a very long summarisation call.
   * The previous summary carries whatever the cap excluded.
   */
  it('caps how much it reads at once', async () => {
    await addMessages(140)
    const result = await loadMessagesBeforeWindow(run, {
      conversationId: CONV, operatorId: OP, windowSize: 20, limit: 30,
    })

    expect(result.totalMessages).toBe(140)
    expect(result.messages).toHaveLength(30)
    // The newest of the fallen-out messages, not the oldest: those are the ones
    // the previous summary has not seen yet.
    expect(result.messages.at(-1)!.body).toBe('message 119')
  })

  it('ignores messages with no body, which carry nothing to summarise', async () => {
    await addMessages(22)
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'audio', null, 'wamid.voice')`,
      [OP, CONV],
    )
    const result = await loadMessagesBeforeWindow(run, {
      conversationId: CONV, operatorId: OP, windowSize: 20,
    })
    expect(result.totalMessages).toBe(22)
  })
})

describe('saveConversationSummary', () => {
  it('stores the summary and how much it covers', async () => {
    await saveConversationSummary(run, {
      conversationId: CONV, operatorId: OP,
      summary: 'Visiting from London, asked twice about the deposit.',
      throughCount: 5,
    })

    const [row] = await run(
      `select summary, summary_through_count, revision from conversations where id = $1`, [CONV],
    )
    expect(row).toMatchObject({
      summary: 'Visiting from London, asked twice about the deposit.',
      summary_through_count: 5,
    })
  })

  /**
   * A note the agent writes to itself is not a change to the conversation.
   * Bumping the revision would make every in-flight turn look superseded, and
   * the agent would fall silent because it took its own notes.
   */
  it('does not touch the revision', async () => {
    const [before] = await run(`select revision from conversations where id = $1`, [CONV])
    await saveConversationSummary(run, {
      conversationId: CONV, operatorId: OP, summary: 'Anything.', throughCount: 1,
    })
    const [after] = await run(`select revision from conversations where id = $1`, [CONV])
    expect(after!['revision']).toBe(before!['revision'])
  })
})
