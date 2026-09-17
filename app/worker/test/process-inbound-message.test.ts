import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConversationContext } from '../src/context.ts'
import type { QueryRunner } from '../src/relay.ts'
import { decideHandling, processInboundMessage } from '../src/tasks/process-inbound-message.ts'

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..','..','db','migrations',
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

  /**
   * The thumbs-up that cost a handoff.
   *
   * A reaction fell into `unsupported` and took the voice-note path: an apology
   * for not being able to read it, and a handoff. The handoff moved the
   * conversation into human hands, so the real question fifty minutes later
   * waited six minutes for an answer.
   */
  it('answers a reaction with nothing, and does not hand it to a person', async () => {
    await run(`update messages set kind = 'reaction', body = null where id = $1`, [messageId])
    expect(decideHandling(await contextFor(), ENABLED))
      .toEqual({ action: 'hold', reason: 'reaction_needs_no_reply' })
  })

  it('holds because no dispatcher exists yet', async () => {
    expect(decideHandling(await contextFor(), { ...ENABLED, dispatcherAvailable: false }))
      .toEqual({ action: 'hold', reason: 'no_dispatcher_yet' })
  })
})

/**
 * A reaction is not an answer.
 *
 * Cancelling the chase on one would end it rather than pause it: the turn is
 * what schedules the next follow-up, and a reaction never reaches the turn. The
 * customer would react once and never hear from us again.
 */
describe('a reaction and the follow-up chase', () => {
  it('leaves a scheduled chase alone', async () => {
    await run(
      `insert into follow_ups (operator_id, conversation_id, attempt, due_at, state, reason)
       values ($1, (select conversation_id from messages where id = $2), 1,
               now() + interval '1 hour', 'scheduled', 'awaiting_customer')`,
      [OPERATOR_A, messageId],
    )
    await run(`update messages set kind = 'reaction', body = null where id = $1`, [messageId])

    await processInboundMessage(run, { message_id: messageId, operator_id: OPERATOR_A }, ENABLED)

    const [chase] = await run(`select state::text as state from follow_ups`, [])
    expect(chase!['state']).toBe('scheduled')
  })

  it('still cancels the chase when they actually reply', async () => {
    await run(
      `insert into follow_ups (operator_id, conversation_id, attempt, due_at, state, reason)
       values ($1, (select conversation_id from messages where id = $2), 1,
               now() + interval '1 hour', 'scheduled', 'awaiting_customer')`,
      [OPERATOR_A, messageId],
    )

    await processInboundMessage(run, { message_id: messageId, operator_id: OPERATOR_A }, ENABLED)

    const [chase] = await run(`select state::text as state from follow_ups`, [])
    expect(chase!['state']).toBe('cancelled')
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

const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'

async function inbound(body: string): Promise<string> {
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
    [OPERATOR_A, CONVERSATION, body, `wamid.${Math.random()}`],
  )
  return rows[0]!['id'] as string
}

/**
 * Build plan follow-on — opt-out is honoured by a rule, before any model runs.
 *
 * The column and every check that reads it already existed; nothing could set
 * it. A model handled "stop" perfectly in the eval run and called nothing,
 * because there was nothing to call.
 */
describe('opt-out', () => {
  it('records the opt-out and holds this turn, not the next one', async () => {
    const id = await inbound('please stop messaging me')
    const result = await processInboundMessage(run, { message_id: id }, ENABLED)

    expect(result).toMatchObject({
      outcome: 'processed',
      handling: { action: 'hold', reason: 'contact_opted_out' },
      optedOut: { matched: 'stop messaging' },
    })

    const [contact] = await run(`select opted_out_at from contacts where id = $1`, [CONTACT])
    expect(contact!['opted_out_at']).not.toBeNull()
  })

  it('cancels queued messages to that contact, staff-written included', async () => {
    const queued = await run(
      `insert into messages
         (operator_id, conversation_id, direction, kind, body, delivery_state, sent_by_membership_id)
       values ($1, $2, 'outbound', 'text', 'Following up on the Ferrari', 'pending', null),
              ($1, $2, 'outbound', 'text', 'Sara here — any thoughts?', 'pending', null)
       returning id`,
      [OPERATOR_A, CONVERSATION],
    )

    const id = await inbound('unsubscribe')
    const result = await processInboundMessage(run, { message_id: id }, ENABLED)
    expect(result).toMatchObject({ optedOut: { cancelledMessages: 2 } })

    const states = await run(
      `select delivery_state::text as state, error_code from messages where id = any($1::uuid[])`,
      [queued.map((r) => r['id'])],
    )
    for (const state of states) {
      expect(state).toMatchObject({ state: 'cancelled', error_code: 'contact_opted_out' })
    }
  })

  it('is idempotent — a second "stop" leaves one record and one audit event', async () => {
    await processInboundMessage(run, { message_id: await inbound('stop') }, ENABLED)
    const [first] = await run(`select opted_out_at from contacts where id = $1`, [CONTACT])

    const second = await processInboundMessage(run, { message_id: await inbound('stop') }, ENABLED)
    // Still held — the flag is set, so the handling is the same.
    expect(second).toMatchObject({ handling: { reason: 'contact_opted_out' } })
    // ...but nothing was recorded a second time.
    expect(second).not.toHaveProperty('optedOut')

    const [after] = await run(`select opted_out_at from contacts where id = $1`, [CONTACT])
    expect(after!['opted_out_at']).toEqual(first!['opted_out_at'])

    const audits = await run(
      `select id from audit_events where action = 'contact.opted_out' and subject_id = $1`, [CONTACT],
    )
    expect(audits).toHaveLength(1)
  })

  it('hands the conversation to a person, since no automated reply can reach them', async () => {
    await processInboundMessage(run, { message_id: await inbound('leave me alone') }, ENABLED)
    const [conversation] = await run(
      `select handler_mode::text as mode, next_action from conversations where id = $1`,
      [CONVERSATION],
    )
    expect(conversation).toMatchObject({ mode: 'human', next_action: 'Customer opted out of messages' })
  })

  it('records what matched, so a mistaken opt-out can be explained', async () => {
    await processInboundMessage(run, { message_id: await inbound('remove me from your list') }, ENABLED)
    const [audit] = await run(
      `select actor_type::text as actor, data from audit_events where action = 'contact.opted_out'`,
      [],
    )
    expect(audit).toMatchObject({ actor: 'customer' })
    expect((audit!['data'] as Record<string, unknown>)['matched']).toBe('remove me from')
  })

  /** A live customer must not be silenced by a pattern that reads too much in. */
  it('leaves an ordinary enquiry alone', async () => {
    const result = await processInboundMessage(
      run, { message_id: await inbound('can I stop by the showroom tomorrow?') }, ENABLED,
    )
    expect(result).toMatchObject({ handling: { action: 'draft' } })
    expect(result).not.toHaveProperty('optedOut')

    const [contact] = await run(`select opted_out_at from contacts where id = $1`, [CONTACT])
    expect(contact!['opted_out_at']).toBeNull()
  })
})
