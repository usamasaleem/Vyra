import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkEligibility, dispatchMessage, type SendIntent } from '../src/dispatcher.ts'
import type { QueryRunner } from '../src/relay.ts'
import { MetaApiError, MetaUnknownOutcomeError, type WhatsAppClient } from '../src/whatsapp/client.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)),'..','..','db','migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'
const MEMBERSHIP = '77777777-7777-7777-7777-777777777777'
const NOW = new Date('2026-09-13T12:00:00.000Z')

let db: PGlite
let run: QueryRunner

const baseIntent = (overrides: Partial<SendIntent> = {}): SendIntent => ({
  messageId: 'm1', operatorId: OPERATOR, conversationId: CONVERSATION,
  body: 'Our Ferrari 296 is available Friday to Sunday.', kind: 'text', replyButtons: null, replyList: null, replyImageUrl: null, quotesProviderId: null,
  sentByMembershipId: null, revisionAtSend: 0, conversationRevision: 0,
  handlerMode: 'ai', ownerMembershipId: null, lastCustomerMessageAt: new Date(NOW.getTime() - 60_000),
  recipient: '971500000001', optedOutAt: null, phoneNumberId: '111',
  ...overrides,
})

describe('eligibility, checked at the moment of sending', () => {
  it('allows a reply inside the 24-hour window', () => {
    expect(checkEligibility(baseIntent(), NOW)).toEqual({ allowed: true })
  })

  it('refuses a reply that crossed the window while queued', () => {
    const intent = baseIntent({ lastCustomerMessageAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) })
    expect(checkEligibility(intent, NOW)).toEqual({
      allowed: false, reason: 'outside_customer_service_window',
    })
  })

  it('refuses right after the boundary and allows right before it', () => {
    const justInside = baseIntent({ lastCustomerMessageAt: new Date(NOW.getTime() - (24 * 60 * 60 * 1000 - 1000)) })
    const justOutside = baseIntent({ lastCustomerMessageAt: new Date(NOW.getTime() - (24 * 60 * 60 * 1000 + 1000)) })
    expect(checkEligibility(justInside, NOW).allowed).toBe(true)
    expect(checkEligibility(justOutside, NOW).allowed).toBe(false)
  })

  /** A channel rule, not an automation rule. */
  it('applies the window to a salesperson message too', () => {
    const intent = baseIntent({
      sentByMembershipId: MEMBERSHIP, handlerMode: 'human',
      lastCustomerMessageAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
    })
    expect(checkEligibility(intent, NOW)).toEqual({
      allowed: false, reason: 'outside_customer_service_window',
    })
  })

  it('suppresses an AI draft once a salesperson has taken over', () => {
    // A person taking over assigns themselves as owner. That, not the mode
    // alone, is what silences the AI.
    const intent = baseIntent({ handlerMode: 'human', ownerMembershipId: MEMBERSHIP })
    expect(checkEligibility(intent, NOW)).toEqual({
      allowed: false, reason: 'conversation_taken_over',
    })
  })

  /**
   * The acknowledgement of a handoff the AI performed itself.
   *
   * Human-owned, but owned by nobody — the AI stepped out and no salesperson
   * has accepted yet. Blocking this meant a customer who asked to speak to
   * someone received nothing at all, which is the one outcome section 17.6
   * rules out. Seen on the first live test.
   */
  it('still sends the handoff acknowledgement the AI wrote as it stepped out', () => {
    const intent = baseIntent({
      handlerMode: 'human', ownerMembershipId: null,
      revisionAtSend: 1, conversationRevision: 1,
    })
    expect(checkEligibility(intent, NOW)).toEqual({ allowed: true })
  })

  /**
   * ...and the allowance is not a loophole. Anything the AI queued before the
   * handoff carries the older revision and stays blocked.
   */
  it('still suppresses a draft written before that handoff', () => {
    const intent = baseIntent({
      handlerMode: 'human', ownerMembershipId: null,
      revisionAtSend: 0, conversationRevision: 1,
    })
    expect(checkEligibility(intent, NOW)).toEqual({
      allowed: false, reason: 'superseded_by_newer_state',
    })
  })

  it('still sends the salesperson own message while they own it', () => {
    const intent = baseIntent({ handlerMode: 'human', sentByMembershipId: MEMBERSHIP })
    expect(checkEligibility(intent, NOW)).toEqual({ allowed: true })
  })

  it('suppresses AI output written against an older revision', () => {
    expect(checkEligibility(baseIntent({ revisionAtSend: 3, conversationRevision: 4 }), NOW)).toEqual({
      allowed: false, reason: 'superseded_by_newer_state',
    })
  })

  it('does not hold a salesperson message to a stale revision', () => {
    const intent = baseIntent({ sentByMembershipId: MEMBERSHIP, revisionAtSend: 3, conversationRevision: 9 })
    expect(checkEligibility(intent, NOW)).toEqual({ allowed: true })
  })

  it('refuses when the contact has opted out', () => {
    expect(checkEligibility(baseIntent({ optedOutAt: NOW }), NOW)).toEqual({
      allowed: false, reason: 'contact_opted_out',
    })
  })

  it('refuses an empty body', () => {
    expect(checkEligibility(baseIntent({ body: '   ' }), NOW).allowed).toBe(false)
  })
})

describe('what may be sent at all', () => {
  /**
   * The bug this caused. A customer asked to see the car, three messages were
   * queued, and two were cancelled as empty — the second and third photographs
   * carry no caption on purpose, so the picture is the entire content. One
   * image arrived and nothing said why.
   */
  it('sends a photograph that carries no caption', () => {
    const verdict = checkEligibility(
      baseIntent({ body: ' ', replyImageUrl: 'https://example.com/side.jpg' }),
      NOW,
    )
    expect(verdict).toMatchObject({ allowed: true })
  })

  it('still refuses a message with nothing in it at all', () => {
    expect(checkEligibility(baseIntent({ body: '  ' }), NOW))
      .toMatchObject({ allowed: false, reason: 'no_body' })
    expect(checkEligibility(baseIntent({ body: null }), NOW))
      .toMatchObject({ allowed: false, reason: 'no_body' })
  })
})

describe('dispatching against the database', () => {
  const sending = (id = 'wamid.SENT'): WhatsAppClient => ({
    sendText: vi.fn(async () => ({ providerMessageId: id })),
    showTyping: vi.fn(async () => {}),
  })

  const queueOutbound = async (fields: Record<string, unknown> = {}) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state,
                             revision_at_send, sent_by_membership_id, idempotency_key, reply_buttons,
                             quotes_message_id)
       values ($1, $2, 'outbound', 'text', $3, 'pending', $4, $5, $6, $7::jsonb, $8::uuid) returning id`,
      [OPERATOR, CONVERSATION, fields.body ?? 'Here are two options.',
       fields.revisionAtSend ?? 0, fields.sentBy ?? null, fields.key ?? `turn-${Math.random()}`,
       fields.replyButtons === undefined ? null : JSON.stringify(fields.replyButtons),
       fields.quotesMessageId ?? null],
    )
    return rows[0]!.id as string
  }

  const stateOf = async (id: string) =>
    (await run('select delivery_state, provider_id, error_code, error_detail from messages where id = $1', [id]))[0]!

  beforeEach(async () => {
    db = await PGlite.create()
    run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }
    await db.exec(`
      insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot');
      insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
      values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '100000000000001');
      insert into memberships (id, operator_id, user_id, role)
      values ('${MEMBERSHIP}', '${OPERATOR}', '10000000-0000-0000-0000-000000000001', 'salesperson');
      insert into contacts (id, operator_id, channel_identifier)
      values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
      insert into conversations (id, operator_id, contact_id, whatsapp_account_id, last_customer_message_at)
      values ('${CONVERSATION}', '${OPERATOR}', '55555555-5555-5555-5555-555555555555',
              '33333333-3333-3333-3333-333333333333', now());
    `)
  })

  it('sends and records the provider message id', async () => {
    const id = await queueOutbound()
    const client = sending('wamid.REAL')
    const result = await dispatchMessage(run, client, id)

    expect(result).toEqual({ outcome: 'sent', providerMessageId: 'wamid.REAL' })
    expect(await stateOf(id)).toMatchObject({ delivery_state: 'accepted', provider_id: 'wamid.REAL' })
    expect(client.sendText).toHaveBeenCalledWith({
      to: '971500000001', body: 'Here are two options.', buttons: null, list: null, imageUrl: null,
      quotesProviderId: null,
    })
  })

  /**
   * Buttons are stored on the message rather than decided at send time, so
   * what the customer was offered survives a retry and a restart. A tapped
   * "Yes, correct" means nothing without the question it answered.
   */
  it('sends the reply buttons that were stored with the message', async () => {
    const buttons = [
      { id: 'dates_confirmed', title: 'Yes, correct' },
      { id: 'dates_wrong', title: 'Different dates' },
    ]
    const id = await queueOutbound({
      body: '20th to 23rd September — that right?',
      replyButtons: buttons,
    })
    const client = sending('wamid.BUTTONS')
    await dispatchMessage(run, client, id)

    expect(client.sendText).toHaveBeenCalledWith({
      to: '971500000001', body: '20th to 23rd September — that right?', buttons, list: null, imageUrl: null,
      quotesProviderId: null,
    })
  })

  /** A duplicated job must not produce a duplicated WhatsApp message. */
  it('sends once even when dispatched twice', async () => {
    const id = await queueOutbound()
    const client = sending()
    const first = await dispatchMessage(run, client, id)
    const second = await dispatchMessage(run, client, id)

    expect(first.outcome).toBe('sent')
    expect(second).toEqual({ outcome: 'already_handled' })
    expect(client.sendText).toHaveBeenCalledTimes(1)
  })

  it('cancels rather than sends when a salesperson took over', async () => {
    const id = await queueOutbound()
    // takeOverConversation assigns the owner as well as flipping the mode, and
    // the owner is what distinguishes a person stepping in from the AI stepping
    // out. A fixture that sets only the mode tests neither.
    await run(
      `update conversations set handler_mode = 'human', owner_membership_id = $2,
              revision = revision + 1 where id = $1`,
      [CONVERSATION, MEMBERSHIP],
    )
    const client = sending()
    const result = await dispatchMessage(run, client, id)

    expect(result).toEqual({ outcome: 'suppressed', reason: 'conversation_taken_over' })
    expect(client.sendText).not.toHaveBeenCalled()
    expect(await stateOf(id)).toMatchObject({ delivery_state: 'cancelled', error_code: 'conversation_taken_over' })
  })

  it('cancels a reply that crossed the 24-hour window while queued', async () => {
    const id = await queueOutbound()
    await run(`update conversations set last_customer_message_at = now() - interval '25 hours' where id = $1`, [CONVERSATION])
    const client = sending()

    expect(await dispatchMessage(run, client, id)).toEqual({
      outcome: 'suppressed', reason: 'outside_customer_service_window',
    })
    expect(client.sendText).not.toHaveBeenCalled()
    expect((await stateOf(id)).delivery_state).toBe('cancelled')
  })

  /** Meta may have delivered it. Neither retry nor call it failed. */
  it('records an ambiguous send as unknown', async () => {
    const id = await queueOutbound()
    const client: WhatsAppClient = {
      showTyping: vi.fn(async () => {}),
      sendText: vi.fn(async () => { throw new MetaUnknownOutcomeError('socket hang up') }),
    }
    const result = await dispatchMessage(run, client, id)

    expect(result).toMatchObject({ outcome: 'unknown' })
    const state = await stateOf(id)
    expect(state.delivery_state).toBe('unknown')
    expect(state.error_detail).toContain('socket hang up')
  })

  it('does not re-send a message whose outcome is unknown', async () => {
    const id = await queueOutbound()
    const client: WhatsAppClient = {
      showTyping: vi.fn(async () => {}),
      sendText: vi.fn(async () => { throw new MetaUnknownOutcomeError('timeout') }),
    }
    await dispatchMessage(run, client, id)
    expect(await dispatchMessage(run, client, id)).toEqual({ outcome: 'already_handled' })
    expect(client.sendText).toHaveBeenCalledTimes(1)
  })

  it('returns a retryable failure to pending', async () => {
    const id = await queueOutbound()
    const client: WhatsAppClient = {
      showTyping: vi.fn(async () => {}),
      sendText: vi.fn(async () => { throw new MetaApiError('upstream', 503, null, true) }),
    }
    const result = await dispatchMessage(run, client, id)

    expect(result).toMatchObject({ outcome: 'failed', retryable: true })
    expect((await stateOf(id)).delivery_state).toBe('pending')
    // And a later attempt can claim it again.
    expect((await dispatchMessage(run, sending(), id)).outcome).toBe('sent')
  })

  it('marks a permanent rejection failed and leaves it alone', async () => {
    const id = await queueOutbound()
    const client: WhatsAppClient = {
      showTyping: vi.fn(async () => {}),
      sendText: vi.fn(async () => { throw new MetaApiError('Invalid parameter', 400, 100, false) }),
    }
    const result = await dispatchMessage(run, client, id)

    expect(result).toMatchObject({ outcome: 'failed', retryable: false })
    expect(await stateOf(id)).toMatchObject({ delivery_state: 'failed', error_code: '100' })
    expect((await dispatchMessage(run, sending(), id)).outcome).toBe('already_handled')
  })

  /**
   * The quoted message is resolved at the moment of sending rather than stored,
   * because a wamid only exists once Meta has accepted the message it names.
   */
  describe('quoting an earlier message', () => {
    it('sends the wamid of the message being quoted', async () => {
      const earlier = await queueOutbound({ body: 'Here she is.' })
      await run(
        `update messages set provider_id = 'wamid.EARLIER', delivery_state = 'accepted' where id = $1`,
        [earlier],
      )

      const reply = await queueOutbound({ body: 'Sent you a few this morning.', quotesMessageId: earlier })
      const client = sending('wamid.NEW')
      await dispatchMessage(run, client, reply)

      expect(client.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ quotesProviderId: 'wamid.EARLIER' }),
      )
    })

    /**
     * A quote is a nicety. A message quoting one that never reached Meta — a
     * draft, a failed send, one still queued — goes out without the bubble
     * rather than not going out at all.
     */
    it('sends without a quote when the quoted message never reached Meta', async () => {
      const earlier = await queueOutbound({ body: 'Here she is.' })
      const reply = await queueOutbound({ body: 'Sent you a few this morning.', quotesMessageId: earlier })

      const client = sending('wamid.NEW')
      const result = await dispatchMessage(run, client, reply)

      expect(result).toMatchObject({ outcome: 'sent' })
      expect(client.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ quotesProviderId: null }),
      )
    })
  })


  /**
   * Which credentials to send with is a property of the message, not of the
   * process. The pilot ran on one token in the worker's environment, which is
   * why a second operator could sign up, add cars, publish answers and send
   * nothing at all.
   */
  describe('sending as whoever owns the number', () => {
    it('asks for a client for the number the message goes out from', async () => {
      const id = await queueOutbound()
      const client = sending('wamid.OWN')
      const asked: string[] = []

      await dispatchMessage(run, async (phoneNumberId) => {
        asked.push(phoneNumberId)
        return client
      }, id)

      expect(asked).toEqual(['100000000000001'])
      expect(client.sendText).toHaveBeenCalled()
    })

    /**
     * Sending as the wrong business is worse than not sending, so a number
     * with no usable credentials fails and is seen. Not retryable: a missing
     * token does not fix itself, and a queue of retries would bury the one
     * thing that needs doing.
     */
    it('fails visibly rather than borrowing somebody else credentials', async () => {
      const id = await queueOutbound()

      const result = await dispatchMessage(run, async () => null, id)

      expect(result).toMatchObject({ outcome: 'failed', retryable: false })
      expect(await stateOf(id)).toMatchObject({
        delivery_state: 'failed', error_code: 'no_credentials',
      })
    })

    /** A single client still works, which is what every other test passes. */
    it('accepts a client directly', async () => {
      const id = await queueOutbound()
      const client = sending('wamid.DIRECT')

      expect(await dispatchMessage(run, client, id)).toMatchObject({ outcome: 'sent' })
    })
  })

})

