import type { QueryRunner } from './relay.js'
import { MetaApiError, MetaUnknownOutcomeError, type WhatsAppClient } from './whatsapp/client.js'

/**
 * Build plan step 11 — the outbound dispatcher.
 *
 * Every check here runs immediately before the send, never when the reply was
 * written. Section 18.5 is explicit: a job queued at hour 23 and dispatched at
 * hour 25 has crossed the window, and the same applies to a message a
 * salesperson typed and a slow queue delayed.
 */

/** WhatsApp allows free-form replies within 24 hours of the last customer message. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

export type SendIntent = {
  messageId: string
  operatorId: string
  conversationId: string
  body: string | null
  kind: string
  /** Reply buttons offered with this message, or null for plain text. */
  replyButtons: Array<{ id: string; title: string }> | null
  /** A tappable list, for choosing between cars. */
  replyList: { button: string; rows: Array<{ id: string; title: string; description?: string }> } | null
  /** A photograph to send with this reply, as a public HTTPS link. */
  replyImageUrl: string | null
  /** Null for AI messages, set for a salesperson's own message. */
  sentByMembershipId: string | null
  revisionAtSend: number | null
  conversationRevision: number
  handlerMode: 'ai' | 'human'
  /** Null when no person has accepted the conversation. */
  ownerMembershipId: string | null
  lastCustomerMessageAt: Date | null
  recipient: string
  optedOutAt: Date | null
  phoneNumberId: string
}

export type SuppressionReason =
  | 'no_body'
  | 'contact_opted_out'
  | 'outside_customer_service_window'
  | 'conversation_taken_over'
  | 'superseded_by_newer_state'

export type EligibilityVerdict =
  | { allowed: true }
  | { allowed: false; reason: SuppressionReason }

/**
 * Whether this exact message may go to this customer right now.
 *
 * The window check applies to human-authored messages too. That surprises
 * people — it is a channel rule, not an automation rule, and section 18.5 says
 * human takeover changes who replies, not what the channel permits.
 */
export function checkEligibility(intent: SendIntent, now: Date): EligibilityVerdict {
  if (intent.body === null || intent.body.trim() === '') {
    return { allowed: false, reason: 'no_body' }
  }
  if (intent.optedOutAt !== null) {
    return { allowed: false, reason: 'contact_opted_out' }
  }

  /**
   * Ownership, checked at dispatch. An AI draft written before a salesperson
   * took over must not land after they did — that is the competing-reply
   * failure section 18.11 exists to prevent. A message the salesperson wrote
   * themselves is unaffected: they own the conversation.
   */
  const isAiAuthored = intent.sentByMembershipId === null
  /**
   * A conversation can be human-owned for two different reasons, and only one
   * of them should silence the AI.
   *
   * A salesperson pressing Take over sets `owner_membership_id`. The AI calling
   * request_handoff leaves it null — nobody has accepted yet, it simply stepped
   * out. Blocking both meant the acknowledgement of a handoff was suppressed by
   * the handoff itself, and a customer asking for a person got nothing at all.
   *
   * Unowned is not a loophole on its own: the revision check immediately below
   * still applies, and the handoff bumped the revision, so every draft written
   * before it is stale and stays blocked. What gets through is the one message
   * queued at the post-handoff revision — the sentence saying a colleague is
   * coming.
   */
  const takenByAPerson = intent.handlerMode === 'human' && intent.ownerMembershipId !== null
  if (isAiAuthored && takenByAPerson) {
    return { allowed: false, reason: 'conversation_taken_over' }
  }

  /**
   * Staleness. If the conversation moved on while this was queued — a
   * correction, a takeover, a policy change — the text may no longer be true.
   * Only AI output is bound to a revision; a salesperson's message says what
   * they meant regardless.
   */
  if (
    isAiAuthored &&
    intent.revisionAtSend !== null &&
    intent.revisionAtSend !== intent.conversationRevision
  ) {
    return { allowed: false, reason: 'superseded_by_newer_state' }
  }

  const lastInbound = intent.lastCustomerMessageAt
  if (lastInbound === null || now.getTime() - lastInbound.getTime() > CUSTOMER_SERVICE_WINDOW_MS) {
    // An approved template is required out here. The MVP creates a task
    // instead of sending, rather than silently dropping the reply.
    return { allowed: false, reason: 'outside_customer_service_window' }
  }

  return { allowed: true }
}

export type DispatchResult =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'already_handled' }
  | { outcome: 'suppressed'; reason: SuppressionReason }
  | { outcome: 'failed'; error: string; retryable: boolean }
  | { outcome: 'unknown'; error: string }

const LOAD_INTENT_SQL = `
  select
    m.id, m.operator_id, m.conversation_id, m.body, m.kind, m.reply_buttons, m.reply_list, m.reply_image_url,
    m.sent_by_membership_id, m.revision_at_send,
    v.revision, v.handler_mode, v.owner_membership_id, v.last_customer_message_at,
    c.channel_identifier, c.opted_out_at,
    a.phone_number_id
  from messages m
  join conversations v on v.id = m.conversation_id and v.operator_id = m.operator_id
  join contacts c on c.id = v.contact_id and c.operator_id = m.operator_id
  join whatsapp_accounts a on a.id = v.whatsapp_account_id and a.operator_id = m.operator_id
  where m.id = $1 and m.direction = 'outbound'
`

/**
 * Claim by state transition. Only one worker can move a row out of `pending`,
 * so a duplicated job cannot produce a duplicated WhatsApp message.
 */
const CLAIM_SQL = `
  update messages set delivery_state = 'dispatching'
  where id = $1 and delivery_state = 'pending'
  returning id
`

export async function dispatchMessage(
  run: QueryRunner,
  client: WhatsAppClient,
  messageId: string,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const claimed = await run(CLAIM_SQL, [messageId])
  if (claimed.length === 0) return { outcome: 'already_handled' }

  const rows = await run(LOAD_INTENT_SQL, [messageId])
  const row = rows[0]
  if (row === undefined) {
    await run(`update messages set delivery_state = 'failed', error_code = 'intent_missing' where id = $1`, [messageId])
    return { outcome: 'failed', error: 'send intent not found', retryable: false }
  }

  const intent: SendIntent = {
    messageId: row['id'] as string,
    operatorId: row['operator_id'] as string,
    conversationId: row['conversation_id'] as string,
    body: (row['body'] as string) ?? null,
    kind: row['kind'] as string,
    // jsonb arrives parsed from postgres.js and from PGlite alike.
    replyButtons:
      (row['reply_buttons'] as Array<{ id: string; title: string }> | null) ?? null,
    replyList: (row['reply_list'] as SendIntent['replyList']) ?? null,
    replyImageUrl: (row['reply_image_url'] as string) ?? null,
    sentByMembershipId: (row['sent_by_membership_id'] as string) ?? null,
    revisionAtSend: row['revision_at_send'] === null ? null : Number(row['revision_at_send']),
    conversationRevision: Number(row['revision']),
    handlerMode: row['handler_mode'] as 'ai' | 'human',
    ownerMembershipId: (row['owner_membership_id'] as string) ?? null,
    lastCustomerMessageAt: toDateOrNull(row['last_customer_message_at']),
    recipient: row['channel_identifier'] as string,
    optedOutAt: toDateOrNull(row['opted_out_at']),
    phoneNumberId: row['phone_number_id'] as string,
  }

  const verdict = checkEligibility(intent, now)
  if (!verdict.allowed) {
    await run(
      `update messages set delivery_state = 'cancelled', error_code = $2 where id = $1`,
      [messageId, verdict.reason],
    )
    return { outcome: 'suppressed', reason: verdict.reason }
  }

  try {
    const { providerMessageId } = await client.sendText({
      to: intent.recipient,
      body: intent.body as string,
      // Stored with the message when it was queued, so what the customer was
      // offered survives a retry and a restart.
      buttons: intent.replyButtons,
      list: intent.replyList,
      imageUrl: intent.replyImageUrl,
    })
    await run(
      `update messages
         set delivery_state = 'accepted', provider_id = $2, error_code = null, error_detail = null
       where id = $1`,
      [messageId, providerMessageId],
    )

    /**
     * The reporting timestamps, set here because this is the moment the
     * customer actually received something.
     *
     * Both columns have existed since schema v1 and nothing wrote them, so
     * first-response time and time-to-salesperson — two of the ten measures
     * section 15 asks for — had no input at all. Queueing a reply is not
     * answering a customer; Meta accepting it is.
     *
     * `first_response_at` uses coalesce so it records the first reply and never
     * moves. A "first response" that updates on every message is just the last
     * message's time wearing a misleading name.
     */
    await run(
      `update conversations
       set first_response_at = coalesce(first_response_at, now()),
           last_staff_response_at = case
             when $2::uuid is not null then now() else last_staff_response_at
           end,
           updated_at = now()
       where id = $1 and operator_id = $3`,
      [intent.conversationId, intent.sentByMembershipId, intent.operatorId],
    )

    return { outcome: 'sent', providerMessageId }
  } catch (error) {
    if (error instanceof MetaUnknownOutcomeError) {
      /**
       * Do not retry and do not call it failed. Meta may have delivered this.
       * Section 18.10: mark the outcome unknown and reconcile against provider
       * events. A local idempotency key cannot resolve a network ambiguity.
       */
      await run(
        `update messages set delivery_state = 'unknown', error_code = 'unknown_outcome', error_detail = $2 where id = $1`,
        [messageId, error.message],
      )
      return { outcome: 'unknown', error: error.message }
    }

    const retryable = error instanceof MetaApiError ? error.retryable : true
    const detail = error instanceof Error ? error.message : String(error)

    if (retryable) {
      // Back to pending so the next attempt can claim it again.
      await run(
        `update messages set delivery_state = 'pending', error_code = 'retryable', error_detail = $2 where id = $1`,
        [messageId, detail],
      )
    } else {
      await run(
        `update messages set delivery_state = 'failed', error_code = $2, error_detail = $3 where id = $1`,
        [messageId, error instanceof MetaApiError ? String(error.code ?? error.httpStatus) : 'permanent', detail],
      )
    }
    return { outcome: 'failed', error: detail, retryable }
  }
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(value as string)
}
