import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConversationContext } from '../src/context.ts'
import type { QueryRunner } from '../src/relay.ts'
import { decideHandling, processInboundMessage } from '../src/tasks/process-inbound-message.ts'

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..','..','..','packages','db','migrations',
)
const OPERATOR_A = '11111111-1111-1111-1111-111111111111'
const OPERATOR_B = '22222222-2222-2222-2222-222222222222'

let db: PGlite
let run: QueryRunner
let messageId: string

const ENABLED = { systemAiSendingEnabled: true, dispatcherAvailable: true }

beforeEach(async () => {
  db = await PGlite.create()
  run = async (text, params) => (await db.query(text, params)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, ai_sending_enabled)
    values ('${OPERATOR_A}', 'Vyra Pilot', 'Asia/Dubai', true),
           ('${OPERATOR_B}', 'Rival Rentals', 'Asia/Dubai', true);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR_A}', 'waba-a', '111'),
           ('44444444-4444-4444-4444-444444444444', '${OPERATOR_B}', 'waba-b', '222');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR_A}', '971500000001', 'Test Customer');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('66666666-6666-6666-6666-666666666666', '${OPERATOR_A}',
            '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333');
  `)
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, '66666666-6666-6666-6666-666666666666', 'inbound', 'text', 'hello no answer?', 'wamid.A')
     returning id`,
    [OPERATOR_A],
  )
  messageId = rows[0]!.id as string
})

describe('loading context', () => {
  it('loads operator, conversation, contact and message together', async () => {
    const context = await loadConversationContext(run, messageId)
    expect(context).not.toBeNull()
    expect(context!.operator).toMatchObject({ name: 'Vyra Pilot', timezone: 'Asia/Dubai' })
    expect(context!.conversation).toMatchObject({ revision: 0, handlerMode: 'ai', salesStage: 'new' })
    expect(context!.contact).toMatchObject({ channelIdentifier: '971500000001', displayName: 'Test Customer' })
    expect(context!.message).toMatchObject({ kind: 'text', body: 'hello no answer?' })
  })

  it('returns the transcript oldest first', async () => {
    for (const [body, wamid] of [['second', 'wamid.B'], ['third', 'wamid.C']]) {
      await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
         values ($1, '66666666-6666-6666-6666-666666666666', 'inbound', 'text', $2, $3)`,
        [OPERATOR_A, body, wamid],
      )
    }
    const context = await loadConversationContext(run, messageId)
    expect(context!.recentMessages.map((m) => m.body)).toEqual(['hello no answer?', 'second', 'third'])
  })

  it('keeps only the newest messages when the limit bites, still oldest first', async () => {
    for (let i = 0; i < 5; i++) {
      await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
         values ($1, '66666666-6666-6666-6666-666666666666', 'inbound', 'text', $2, $3)`,
        [OPERATOR_A, `msg-${i}`, `wamid.${i}`],
      )
    }
    const context = await loadConversationContext(run, messageId, { recentMessageLimit: 3 })
    expect(context!.recentMessages.map((m) => m.body)).toEqual(['msg-2', 'msg-3', 'msg-4'])
  })

  it('returns null for a message that does not exist', async () => {
    expect(await loadConversationContext(run, '77777777-7777-7777-7777-777777777777')).toBeNull()
  })
})

describe('deciding what happens next', () => {
  const contextFor = async () => (await loadConversationContext(run, messageId))!

  it('is ready for an AI turn when nothing blocks it', async () => {
    expect(decideHandling(await contextFor(), ENABLED)).toEqual({
      action: 'draft', reason: 'ready_for_ai_turn',
    })
  })

  it('the system kill switch wins over everything', async () => {
    expect(decideHandling(await contextFor(), { ...ENABLED, systemAiSendingEnabled: false }))
      .toEqual({ action: 'hold', reason: 'system_kill_switch' })
  })

  it('holds when the operator has AI sending disabled', async () => {
    await run(`update operators set ai_sending_enabled = false where id = $1`, [OPERATOR_A])
    expect(decideHandling(await contextFor(), ENABLED))
      .toEqual({ action: 'hold', reason: 'operator_ai_disabled' })
  })

  /** One handler sends replies at a time. */
  it('holds when a salesperson owns the conversation', async () => {
    await run(`update conversations set handler_mode = 'human' where operator_id = $1`, [OPERATOR_A])
    expect(decideHandling(await contextFor(), ENABLED))
      .toEqual({ action: 'hold', reason: 'human_owns_the_conversation' })
  })

  it('holds when the contact has opted out', async () => {
    await run(`update contacts set opted_out_at = now() where operator_id = $1`, [OPERATOR_A])
    expect(decideHandling(await contextFor(), ENABLED))
      .toEqual({ action: 'hold', reason: 'contact_opted_out' })
  })

  /** A voice note is routed to a person, never treated as silence. */
  it('routes a non-text message to a person', async () => {
    await run(`update messages set kind = 'audio', body = null where id = $1`, [messageId])
    expect(decideHandling(await contextFor(), ENABLED))
      .toEqual({ action: 'hold', reason: 'non_text_needs_a_person' })
  })

  it('holds because no dispatcher exists yet', async () => {
    expect(decideHandling(await contextFor(), { ...ENABLED, dispatcherAvailable: false }))
      .toEqual({ action: 'hold', reason: 'no_dispatcher_yet' })
  })
})

describe('processing a job', () => {
  it('processes a real job payload', async () => {
    const result = await processInboundMessage(run, { message_id: messageId, operator_id: OPERATOR_A }, ENABLED)
    expect(result.outcome).toBe('processed')
    if (result.outcome === 'processed') {
      expect(result.handling.action).toBe('draft')
      expect(result.context.message.body).toBe('hello no answer?')
    }
  })

  it('treats a vanished message as done, not failed', async () => {
    const result = await processInboundMessage(
      run, { message_id: '77777777-7777-7777-7777-777777777777' }, ENABLED,
    )
    expect(result.outcome).toBe('message_not_found')
  })

  it('rejects a payload naming the wrong operator', async () => {
    const result = await processInboundMessage(run, { message_id: messageId, operator_id: OPERATOR_B }, ENABLED)
    expect(result.outcome).toBe('operator_mismatch')
  })

  it('ignores a malformed payload rather than throwing', async () => {
    expect((await processInboundMessage(run, {}, ENABLED)).outcome).toBe('message_not_found')
    expect((await processInboundMessage(run, { message_id: 42 }, ENABLED)).outcome).toBe('message_not_found')
  })

  /**
   * The worker bypasses row-level security, so operator scoping in its queries
   * is the only thing standing between two tenants.
   */
  it('cannot reach another operator conversation through a crafted payload', async () => {
    await db.exec(`
      insert into contacts (id, operator_id, channel_identifier)
      values ('88888888-8888-8888-8888-888888888888', '${OPERATOR_B}', '971500000001');
      insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
      values ('99999999-9999-9999-9999-999999999999', '${OPERATOR_B}',
              '88888888-8888-8888-8888-888888888888', '44444444-4444-4444-4444-444444444444');
    `)
    const rival = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, '99999999-9999-9999-9999-999999999999', 'inbound', 'text', 'rival secret', 'wamid.R')
       returning id`,
      [OPERATOR_B],
    )
    const result = await processInboundMessage(
      run, { message_id: rival[0]!.id, operator_id: OPERATOR_A }, ENABLED,
    )
    expect(result.outcome).toBe('operator_mismatch')
  })
})
