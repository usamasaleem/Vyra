import type { QueryRunner } from '../runner.js'

/**
 * Creating a send intent — section 18.4 step 10.
 *
 * The message row and its outbox job are written in one statement, so a reply
 * that exists is always a reply that will be attempted. The idempotency key
 * collapses two attempts to queue the same logical reply into one row.
 *
 * This is the only way to queue an outbound message, for AI turns and for
 * salespeople alike. Section 18.12: never build a second way to send.
 */
const QUEUE_OUTBOUND_SQL = `
with conversation as (
  select id, operator_id, revision
  from conversations
  where id = $1 and operator_id = $2
),
intent as (
  insert into messages (
    operator_id, conversation_id, direction, kind, body,
    delivery_state, idempotency_key, revision_at_send, sent_by_membership_id,
    reply_buttons, reply_list
  )
  select v.operator_id, v.id, 'outbound', 'text', $3, 'pending', $4,
         case when $5::uuid is null then v.revision else null end, $5::uuid,
         $6::jsonb, $7::jsonb
  from conversation v
  on conflict do nothing
  returning id, operator_id, conversation_id
),
job as (
  insert into outbox (operator_id, event_type, aggregate_id, payload)
  select i.operator_id, 'dispatch_outbound', i.id,
         jsonb_build_object('message_id', i.id, 'conversation_id', i.conversation_id)
  from intent i
  returning id
)
select (select id from intent) as message_id, (select id from job) as outbox_id
`

export type QueuedOutbound = {
  messageId: string | null
  outboxId: string | null
  /** True when this logical reply was already queued. */
  duplicate: boolean
}

export async function queueOutboundText(
  run: QueryRunner,
  input: {
    conversationId: string
    operatorId: string
    body: string
    /** Stable per logical reply, e.g. `turn:<message_id>` or `staff:<uuid>`. */
    idempotencyKey: string
    /** Set for a salesperson's own message; null for AI output. */
    sentByMembershipId?: string | null
    /** Reply buttons to offer with this message. Null sends plain text. */
    replyButtons?: Array<{ id: string; title: string }> | null
    /** A tappable list of options. A message carries buttons or a list, not both. */
    replyList?: { button: string; rows: Array<{ id: string; title: string; description?: string }> } | null
  },
): Promise<QueuedOutbound> {
  const rows = await run(QUEUE_OUTBOUND_SQL, [
    input.conversationId,
    input.operatorId,
    input.body,
    input.idempotencyKey,
    input.sentByMembershipId ?? null,
    input.replyButtons === undefined || input.replyButtons === null
      ? null
      : JSON.stringify(input.replyButtons),
    input.replyList === undefined || input.replyList === null
      ? null
      : JSON.stringify(input.replyList),
  ])
  const row = rows[0]
  const messageId = (row?.['message_id'] as string) ?? null
  return {
    messageId,
    outboxId: (row?.['outbox_id'] as string) ?? null,
    duplicate: messageId === null,
  }
}
