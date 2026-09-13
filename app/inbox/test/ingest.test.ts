import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  storeInboundEventOnly,
  storeInboundMessage,
  type QueryRunner,
} from '../src/lib/whatsapp/ingest.ts'

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..','..','db','migrations',
)

const PHONE_NUMBER_ID = '100000000000001'
const WA_ID = '971500000001'

let db: PGlite
let run: QueryRunner

/** The exact payload Meta delivered on 13 September 2026. */
const realPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '200000000000001', changes: [{ field: 'messages', value: {} }] }],
}

const message = (overrides: Partial<Parameters<typeof storeInboundMessage>[1]> = {}) => ({
  phoneNumberId: PHONE_NUMBER_ID,
  providerEventKey: 'message:wamid.TEST1',
  rawPayload: realPayload,
  waId: WA_ID,
  profileName: 'Test Customer',
  providerMessageId: 'wamid.TEST1',
  kind: 'text',
  body: 'usama here',
  media: null,
  sentAt: new Date('2026-09-13T19:27:28.000Z'),
  ...overrides,
})

const count = async (table: string) => {
  const rows = await run(`select count(*)::int as n from ${table}`, [])
  return rows[0]!.n as number
}

beforeEach(async () => {
  db = await PGlite.create()
  run = async (text, params) => (await db.query(text, params)).rows as Array<Record<string, unknown>>

  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('11111111-1111-1111-1111-111111111111', 'Vyra Pilot');
    insert into whatsapp_accounts (operator_id, provider_account_id, phone_number_id)
    values ('11111111-1111-1111-1111-111111111111', '200000000000001', '${PHONE_NUMBER_ID}');
  `)
})

describe('storing an inbound message', () => {
  it('writes event, contact, conversation, message and job together', async () => {
    const outcome = await storeInboundMessage(run, message())

    expect(outcome.accountFound).toBe(true)
    expect(outcome.duplicate).toBe(false)
    for (const id of [outcome.eventId, outcome.contactId, outcome.conversationId, outcome.messageId, outcome.outboxId]) {
      expect(id).toBeTruthy()
    }
    expect(await count('inbound_events')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('outbox')).toBe(1)
  })

  it('stores the body and resolves the operator from the receiving number', async () => {
    await storeInboundMessage(run, message())
    const rows = await run(
      `select m.body, m.direction, m.kind, m.provider_id, c.channel_identifier, c.display_name, o.name as operator
       from messages m
       join contacts c on c.operator_id = m.operator_id
       join operators o on o.id = m.operator_id`, [],
    )
    expect(rows[0]).toMatchObject({
      body: 'usama here',
      direction: 'inbound',
      kind: 'text',
      provider_id: 'wamid.TEST1',
      channel_identifier: WA_ID,
      display_name: 'Test Customer',
      operator: 'Vyra Pilot',
    })
  })

  /** The guarantee the whole step exists for. */
  it('writes nothing at all when the event is redelivered', async () => {
    const first = await storeInboundMessage(run, message())
    const second = await storeInboundMessage(run, message())

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.messageId).toBeNull()
    expect(second.outboxId).toBeNull()

    expect(await count('inbound_events')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('conversations')).toBe(1)
    expect(await count('outbox')).toBe(1)
  })

  it('reopens the existing conversation when the customer replies later', async () => {
    const first = await storeInboundMessage(run, message())
    const second = await storeInboundMessage(run, message({
      providerEventKey: 'message:wamid.TEST2',
      providerMessageId: 'wamid.TEST2',
      body: 'still here',
      sentAt: new Date('2026-09-15T08:00:00.000Z'),
    }))

    expect(second.conversationId).toBe(first.conversationId)
    expect(await count('conversations')).toBe(1)
    expect(await count('messages')).toBe(2)

    const rows = await run('select last_customer_message_at from conversations', [])
    expect(new Date(rows[0]!.last_customer_message_at as string).toISOString())
      .toBe('2026-09-15T08:00:00.000Z')
  })

  it('writes nothing for an unknown receiving number', async () => {
    const outcome = await storeInboundMessage(run, message({ phoneNumberId: 'NOT_OURS' }))

    expect(outcome.accountFound).toBe(false)
    expect(outcome.duplicate).toBe(false)
    expect(await count('inbound_events')).toBe(0)
    expect(await count('messages')).toBe(0)
  })

  it('writes nothing when the account is deactivated', async () => {
    await db.exec('update whatsapp_accounts set active = false')
    const outcome = await storeInboundMessage(run, message())
    expect(outcome.accountFound).toBe(false)
    expect(await count('messages')).toBe(0)
  })

  /** A voice note must be stored and routed, never silently dropped. */
  it('stores an unsupported kind rather than discarding it', async () => {
    const outcome = await storeInboundMessage(run, message({
      kind: 'audio', body: null, media: { type: 'audio' },
    }))
    expect(outcome.messageId).toBeTruthy()

    const rows = await run('select kind, body, media from messages', [])
    expect(rows[0]).toMatchObject({ kind: 'audio', body: null })
    expect(rows[0]!.media).toEqual({ type: 'audio' })
  })

  it('queues exactly one job per stored message', async () => {
    await storeInboundMessage(run, message())
    const rows = await run('select event_type, aggregate_id, status, attempts from outbox', [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: 'process_inbound_message',
      status: 'pending',
      attempts: 0,
    })
  })
})

describe('storing a status event', () => {
  it('stores it without creating a message', async () => {
    const outcome = await storeInboundEventOnly(run, {
      phoneNumberId: PHONE_NUMBER_ID,
      providerEventKey: 'status:wamid.TEST1:delivered',
      rawPayload: realPayload,
    })
    expect(outcome.eventId).toBeTruthy()
    expect(await count('inbound_events')).toBe(1)
    expect(await count('messages')).toBe(0)
  })

  it('deduplicates a redelivered status', async () => {
    const input = {
      phoneNumberId: PHONE_NUMBER_ID,
      providerEventKey: 'status:wamid.TEST1:delivered',
      rawPayload: realPayload,
    }
    await storeInboundEventOnly(run, input)
    expect((await storeInboundEventOnly(run, input)).duplicate).toBe(true)
    expect(await count('inbound_events')).toBe(1)
  })

  it('keeps sent and delivered as distinct events for one message', async () => {
    for (const status of ['sent', 'delivered', 'read']) {
      await storeInboundEventOnly(run, {
        phoneNumberId: PHONE_NUMBER_ID,
        providerEventKey: `status:wamid.TEST1:${status}`,
        rawPayload: realPayload,
      })
    }
    expect(await count('inbound_events')).toBe(3)
  })
})
