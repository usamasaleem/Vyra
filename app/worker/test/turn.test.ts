import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { scriptedModel, type ModelResponse } from '../../agent/src/turn/model.ts'
import { loadConversationContext, type ConversationContext } from '../src/context.ts'
import { runConversationTurn } from '../src/turn.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let context: ConversationContext

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
     values ($1, $2, 'inbound', 'text', 'I need a Ferrari on Friday', 'wamid.1') returning id`,
    [OP, CONV],
  )
  context = (await loadConversationContext(run, rows[0]!['id'] as string))!
})

const REPLIES: ModelResponse[] = [
  {
    toolCalls: [{
      id: 't1', name: 'record_enquiry_fields',
      arguments: { fields: [{ field: 'vehicle', value: 'Ferrari', originalWording: null }] },
    }],
    reply: null,
  },
  { toolCalls: [], reply: 'Lovely — which Friday, and delivery or collection?' },
]

const turn = (script: ModelResponse[], destination: 'send' | 'draft' = 'send', ctx = context) =>
  runConversationTurn(
    { run, transact, model: scriptedModel('test', script), destination },
    ctx,
  )

describe('a turn that works', () => {
  it('queues the reply and records what the customer said', async () => {
    const result = await turn(REPLIES)
    expect(result).toMatchObject({ outcome: 'queued' })

    const [message] = await run(
      `select body, delivery_state::text as state from messages
       where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message).toMatchObject({
      body: 'Lovely — which Friday, and delivery or collection?', state: 'pending',
    })

    // The tools ran against the real database, not a mock of one.
    const fields = await run(
      `select field::text as field, source_message_id from field_evidence where operator_id = $1`, [OP],
    )
    expect(fields[0]).toMatchObject({ field: 'vehicle', source_message_id: context.message.id })
  })

  it('is safe to retry — a repeated job does not reply twice', async () => {
    await turn(REPLIES)
    await turn(REPLIES)
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(1)
  })
})

describe('shadow mode', () => {
  /**
   * The reply becomes an internal note. Section 18.12 keeps notes away from the
   * dispatcher entirely, so a shadow draft is not merely unsent — it has no
   * route to a customer.
   */
  it('writes the reply where a person can read it and a customer cannot', async () => {
    const result = await turn(REPLIES, 'draft')
    expect(result).toMatchObject({ outcome: 'drafted' })

    const notes = await run(`select body, author_membership_id from conversation_notes`, [])
    expect(notes).toHaveLength(1)
    expect(notes[0]!['body']).toContain('which Friday')
    // Nobody wrote it, so nobody is credited with writing it.
    expect(notes[0]!['author_membership_id']).toBeNull()

    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)
  })
})

describe('a turn overtaken while it was thinking', () => {
  it('is discarded when the customer corrects themselves', async () => {
    /**
     * The correction lands *during* the model call, which is the only moment
     * that matters: after the revision was captured and before the reply is
     * accepted. Awaited inside `complete`, so the ordering is guaranteed rather
     * than left to whichever promise settles first.
     */
    const overtaken = {
      label: 'overtaken',
      modelId: 'overtaken:1',
      complete: async () => {
        await db.query(`update conversations set revision = revision + 1 where id = '${CONV}'`)
        return { toolCalls: [], reply: 'Friday is fine!' }
      },
    }
    const result = await runConversationTurn(
      { run, transact, model: overtaken, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'superseded' })

    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)

    const [audit] = await run(
      `select action from audit_events where subject_id = $1 and action = 'turn.rejected'`, [CONV],
    )
    expect(audit).toBeDefined()
  })
})

describe('a turn that fails', () => {
  it('raises a visible task when the provider is down', async () => {
    const broken = { label: 'broken', modelId: 'broken:1', complete: async () => { throw new Error('503 upstream') } }
    const result = await runConversationTurn(
      { run, transact, model: broken, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'failed', kind: 'provider_error' })

    const [conversation] = await run(
      `select handler_mode::text as mode, priority::text as priority, next_action
       from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'human', priority: 'high' })
    expect(conversation!['next_action']).toContain('reply manually')
  })

  it('raises a task when the model says nothing at all', async () => {
    const result = await turn([{ toolCalls: [], reply: null }])
    expect(result).toMatchObject({ outcome: 'failed', kind: 'no_output' })
  })

  /** The customer must not be left in silence because a tool call misfired. */
  it('still replies when its tools refused', async () => {
    const result = await turn([
      { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
      { toolCalls: [], reply: "I'll confirm the deposit and come back to you." },
    ])
    expect(result).toMatchObject({ outcome: 'queued' })
  })
})

describe('no model configured', () => {
  it('skips the turn instead of failing the job', async () => {
    const result = await runConversationTurn(
      { run, transact, model: null, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'no_model_configured' })

    // Nothing raised, nothing queued — a missing key is a configuration state,
    // not an incident.
    expect(await run(`select id from audit_events`, [])).toHaveLength(0)
  })
})
