import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

let db: PGlite
let operatorA: string
let operatorB: string
let accountA: string
let accountB: string

/** Applies every migration in order, the way a release would. */
async function migrate(database: PGlite) {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const file of files) {
    await database.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
}

beforeAll(async () => {
  db = await PGlite.create()
  await migrate(db)

  const seed = async (name: string, phoneNumberId: string) => {
    const op = await db.query<{ id: string }>(
      'insert into operators (name) values ($1) returning id',
      [name],
    )
    const operatorId = op.rows[0]!.id
    const acct = await db.query<{ id: string }>(
      `insert into whatsapp_accounts (operator_id, provider_account_id, phone_number_id)
       values ($1, $2, $3) returning id`,
      [operatorId, `waba_${name}`, phoneNumberId],
    )
    return [operatorId, acct.rows[0]!.id] as const
  }

  ;[operatorA, accountA] = await seed('operator_a', '111111')
  ;[operatorB, accountB] = await seed('operator_b', '222222')
})

describe('schema v1 applies', () => {
  it('creates every table, and nothing unexpected', async () => {
    const result = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    )
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'audit_events',
      'contacts',
      // Internal notes live apart from messages on purpose: the dispatcher
      // only reads `messages`, so a note cannot reach a customer.
      'conversation_notes',
      'conversations',
      // A rental request, separate from the conversation: a customer can have
      // more than one.
      'enquiries',
      // Every extracted fact with its source message and extraction time.
      'field_evidence',
      'handoffs',
      'inbound_events',
      // Approved operator knowledge, versioned, with a check constraint that
      // makes placeholder content unpublishable.
      'knowledge_entries',
      'memberships',
      'messages',
      'operators',
      'outbox',
      'vehicles',
      'whatsapp_accounts',
    ])
  })

  it('puts operator_id on every table', async () => {
    const result = await db.query<{ table_name: string }>(
      `select t.table_name from information_schema.tables t
       where t.table_schema = 'public'
         and t.table_name <> 'operators'
         and not exists (
           select 1 from information_schema.columns c
           where c.table_schema = 'public'
             and c.table_name = t.table_name
             and c.column_name = 'operator_id')`,
    )
    expect(result.rows).toEqual([])
  })
})

describe('duplicate protection', () => {
  it('rejects a redelivered webhook event', async () => {
    const insert = () =>
      db.query(
        `insert into inbound_events (operator_id, whatsapp_account_id, provider_event_key, payload)
         values ($1, $2, 'wamid.DUPLICATE', '{}'::jsonb)`,
        [operatorA, accountA],
      )

    await insert()
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i)
  })

  it('lets two operators receive the same provider event key independently', async () => {
    const insert = (operatorId: string, accountId: string) =>
      db.query(
        `insert into inbound_events (operator_id, whatsapp_account_id, provider_event_key, payload)
         values ($1, $2, 'wamid.SHARED', '{}'::jsonb)`,
        [operatorId, accountId],
      )

    await insert(operatorA, accountA)
    await expect(insert(operatorB, accountB)).resolves.toBeDefined()
  })
})

describe('tenant isolation is structural', () => {
  it('allows the same WhatsApp number to be a contact of two operators', async () => {
    const insert = (operatorId: string) =>
      db.query('insert into contacts (operator_id, channel_identifier) values ($1, $2)', [
        operatorId,
        '+971500000001',
      ])

    await insert(operatorA)
    await expect(insert(operatorB)).resolves.toBeDefined()
  })

  it('refuses a conversation that references another operator contact', async () => {
    const contact = await db.query<{ id: string }>(
      `insert into contacts (operator_id, channel_identifier)
       values ($1, '+971500000002') returning id`,
      [operatorB],
    )

    await expect(
      db.query(
        `insert into conversations (operator_id, contact_id, whatsapp_account_id)
         values ($1, $2, $3)`,
        [operatorA, contact.rows[0]!.id, accountA],
      ),
    ).rejects.toThrow(/foreign key/i)
  })
})

describe('outbound send intents', () => {
  let conversationId: string

  beforeAll(async () => {
    const contact = await db.query<{ id: string }>(
      `insert into contacts (operator_id, channel_identifier)
       values ($1, '+971500000003') returning id`,
      [operatorA],
    )
    const conversation = await db.query<{ id: string }>(
      `insert into conversations (operator_id, contact_id, whatsapp_account_id)
       values ($1, $2, $3) returning id`,
      [operatorA, contact.rows[0]!.id, accountA],
    )
    conversationId = conversation.rows[0]!.id
  })

  it('sends one logical intent at most once', async () => {
    const insert = () =>
      db.query(
        `insert into messages (operator_id, conversation_id, direction, kind, idempotency_key)
         values ($1, $2, 'outbound', 'text', 'turn-7-reply')`,
        [operatorA, conversationId],
      )

    await insert()
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i)
  })

  it('does not collide rows that have no idempotency key', async () => {
    const insert = () =>
      db.query(
        `insert into messages (operator_id, conversation_id, direction, kind, body)
         values ($1, $2, 'inbound', 'text', 'hi')`,
        [operatorA, conversationId],
      )

    await insert()
    await expect(insert()).resolves.toBeDefined()
  })

  it('starts a conversation at revision 0 owned by the AI', async () => {
    const result = await db.query<{ revision: number; handler_mode: string; sales_stage: string }>(
      'select revision, handler_mode, sales_stage from conversations where id = $1',
      [conversationId],
    )
    expect(result.rows[0]).toMatchObject({
      revision: 0,
      handler_mode: 'ai',
      sales_stage: 'new',
    })
  })
})
