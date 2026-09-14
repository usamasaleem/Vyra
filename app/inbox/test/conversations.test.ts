import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { getConversationThread, listConversations } from '../src/lib/queries/conversations.ts'
import type { QueryRunner } from '../../db/src/runner.ts'

/**
 * The queries behind everything a salesperson sees, which had no tests.
 *
 * That absence had a cost: `next_action` was written by three separate paths
 * and selected by neither of these, so the agent recorded "I'll confirm the
 * deposit" faithfully and the inbox showed an ordinary conversation. Nothing
 * failed, because nothing was checking.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'

let db: PGlite
let run: QueryRunner

async function conversation(opts: {
  operator?: string
  phone: string
  nextAction?: string | null
  priority?: string
} ): Promise<string> {
  const operator = opts.operator ?? OP
  const account = operator === OP ? ACCOUNT : '44444444-4444-4444-4444-444444444444'
  const [contact] = await run(
    `insert into contacts (operator_id, channel_identifier) values ($1, $2) returning id`,
    [operator, opts.phone],
  )
  const [conv] = await run(
    `insert into conversations (operator_id, contact_id, whatsapp_account_id, next_action, priority,
                               last_customer_message_at)
     values ($1, $2, $3, $4, $5::priority, now()) returning id`,
    [operator, contact!['id'], account, opts.nextAction ?? null, opts.priority ?? 'normal'],
  )
  const id = conv!['id'] as string
  await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body)
     values ($1, $2, 'inbound', 'text', 'hello')`,
    [operator, id],
  )
  return id
}

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', 'Asia/Dubai'), ('${RIVAL}', 'Rival Rentals', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id) values
      ('${ACCOUNT}', '${OP}', 'waba-a', '111'),
      ('44444444-4444-4444-4444-444444444444', '${RIVAL}', 'waba-b', '222');
  `)
})

describe('what a conversation needs from a person', () => {
  it('appears in the list', async () => {
    await conversation({ phone: '971500000001', nextAction: 'Waiting on you: publish a deposit answer' })
    const [row] = await listConversations(run, OP)
    expect(row!.nextAction).toBe('Waiting on you: publish a deposit answer')
  })

  it('appears in the thread', async () => {
    const id = await conversation({ phone: '971500000002', nextAction: 'Customer asked for a person.' })
    const thread = await getConversationThread(run, OP, id)
    expect(thread!.nextAction).toBe('Customer asked for a person.')
  })

  it('is null when nothing is outstanding', async () => {
    await conversation({ phone: '971500000003' })
    const [row] = await listConversations(run, OP)
    expect(row!.nextAction).toBeNull()
  })
})

describe('the queue of conversations waiting on somebody', () => {
  it('is a filter, not something to scroll for', async () => {
    await conversation({ phone: '971500000001', nextAction: 'check availability' })
    await conversation({ phone: '971500000002' })
    await conversation({ phone: '971500000003', nextAction: 'publish a deposit answer' })

    const waiting = await listConversations(run, OP, { needsAttention: true })
    expect(waiting).toHaveLength(2)
    expect(waiting.every((c) => c.nextAction !== null)).toBe(true)

    const everything = await listConversations(run, OP)
    expect(everything).toHaveLength(3)
  })

  /**
   * Priority still wins. An accident report with nothing outstanding outranks a
   * deposit question that is waiting on someone.
   */
  it('does not outrank priority', async () => {
    await conversation({ phone: '971500000001', nextAction: 'publish a deposit answer' })
    const urgent = await conversation({ phone: '971500000002', priority: 'urgent' })

    const rows = await listConversations(run, OP)
    expect(rows[0]!.id).toBe(urgent)
  })

  it('but wins within the same priority', async () => {
    await conversation({ phone: '971500000001' })
    const waiting = await conversation({ phone: '971500000002', nextAction: 'check availability' })

    const rows = await listConversations(run, OP)
    expect(rows[0]!.id).toBe(waiting)
  })
})

describe('tenant isolation', () => {
  it('lists only this operator conversations', async () => {
    await conversation({ phone: '971500000001', nextAction: 'ours' })
    await conversation({ operator: RIVAL, phone: '971500000009', nextAction: 'theirs' })

    const rows = await listConversations(run, OP)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.nextAction).toBe('ours')
  })

  /** Not found rather than forbidden: a different answer confirms the id exists. */
  it('reports another operator conversation as not found', async () => {
    const theirs = await conversation({ operator: RIVAL, phone: '971500000009' })
    expect(await getConversationThread(run, OP, theirs)).toBeNull()
  })
})
