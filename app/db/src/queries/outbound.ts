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
    reply_buttons, reply_list, reply_image_url, quotes_message_id, reply_link
  )
  select v.operator_id, v.id, 'outbound', 'text', $3, 'pending', $4,
         case when $5::uuid is null then v.revision else null end, $5::uuid,
         $6::jsonb, $7::jsonb, $8, $11::uuid, $12::jsonb
  from conversation v
  on conflict do nothing
  returning id, operator_id, conversation_id
),
job as (
  insert into outbox (operator_id, event_type, aggregate_id, payload)
  select i.operator_id, 'dispatch_outbound', i.id,
         jsonb_build_object(
           'message_id', i.id,
           'conversation_id', i.conversation_id,
           -- Further messages to send in the same job, in this order, rather
           -- than one queue hop each. See the alsoSend option.
           'also_message_ids', coalesce($10::jsonb, '[]'::jsonb)
         )
  from intent i
  -- Skipped when this message is itself a follow-up: it is dispatched by the
  -- job belonging to the message it follows.
  where $9::boolean is not true
  returning id
)
select (select id from intent) as message_id, (select id from job) as outbox_id
`

/**
 * A person's message goes out with their name on it.
 *
 * The alternative designs were both worse. Announcing a handover — "Ahmed has
 * joined the conversation" — sounds right and does not survive contact with
 * the data: `ai_resumes_after_minutes` is five, so the assistant takes the
 * thread back before a salesperson has finished looking something up, and one
 * live conversation already flips six times against six human messages in the
 * entire database. That is an announcement per reply. Announcing only the
 * human and staying quiet when the agent returns is worse still: the customer
 * is then told, once, that they are speaking to Ahmed, and goes on believing
 * it while the machine answers.
 *
 * A signature has no state to get wrong. Signed is a person, unsigned is the
 * assistant, and the thread reads correctly however many times it changes
 * hands. It is also the only moment a customer learns there are real people
 * here at all.
 *
 * Every human message, not just the first of a stretch. The first-only version
 * needs to know where a stretch begins, which is the handover state this is
 * deliberately not built on.
 */
export class NoDisplayName extends Error {
  membershipId: string

  constructor(membershipId: string) {
    super(`Membership ${membershipId} has no display name, so it cannot send.`)
    this.name = 'NoDisplayName'
    this.membershipId = membershipId
  }
}

export function signed(body: string, name: string): string {
  const signature = `— ${name}`
  // Already signed: a caller that queued its own name, or a retry of a body
  // read back from the record.
  return body.trimEnd().endsWith(signature) ? body : `${body.trimEnd()}\n${signature}`
}

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
    /** A photograph to send with this reply, as a public HTTPS link. */
    replyImageUrl?: string | null
    /**
     * Queue the message without a dispatch job of its own.
     *
     * For a follow-up that another message's job will send. Only ever set
     * alongside an `alsoSend` naming it, or the message is queued and never
     * sent — so the two are always written together, in one transaction.
     */
    withoutOwnJob?: boolean
    /**
     * Messages this job should send after this one, in this order.
     *
     * Several photographs arriving over five seconds feel slower than the same
     * photographs arriving over five hundred milliseconds, and the gap is queue
     * latency rather than anything Meta does. One job sends them back to back.
     */
    alsoSend?: string[]
    /**
     * An earlier message in this conversation to quote. Meta shows it in a
     * bubble above the reply, and tapping it jumps there.
     */
    quotesMessageId?: string | null
    /** A labelled link, sent as a cta_url button. */
    replyLink?: { label: string; url: string } | null
  },
): Promise<QueuedOutbound> {
  /**
   * Signed here rather than at the call site, because this is the only way to
   * queue anything — "never build a second way to send" is what makes that
   * enforceable. A caller that forgets cannot send unsigned; it cannot send.
   */
  let body = input.body
  if (input.sentByMembershipId != null) {
    const [who] = await run(
      `select display_name from memberships where id = $1 and operator_id = $2`,
      [input.sentByMembershipId, input.operatorId],
    )
    const name = ((who?.['display_name'] as string) ?? '').trim()
    if (name === '') throw new NoDisplayName(input.sentByMembershipId)
    body = signed(input.body, name)
  }

  const rows = await run(QUEUE_OUTBOUND_SQL, [
    input.conversationId,
    input.operatorId,
    body,
    input.idempotencyKey,
    input.sentByMembershipId ?? null,
    input.replyButtons === undefined || input.replyButtons === null
      ? null
      : JSON.stringify(input.replyButtons),
    input.replyList === undefined || input.replyList === null
      ? null
      : JSON.stringify(input.replyList),
    input.replyImageUrl ?? null,
    input.withoutOwnJob ?? false,
    input.alsoSend === undefined || input.alsoSend.length === 0
      ? null
      : JSON.stringify(input.alsoSend),
    input.quotesMessageId ?? null,
    input.replyLink === undefined || input.replyLink === null
      ? null
      : JSON.stringify(input.replyLink),
  ])
  const row = rows[0]
  const messageId = (row?.['message_id'] as string) ?? null
  return {
    messageId,
    outboxId: (row?.['outbox_id'] as string) ?? null,
    duplicate: messageId === null,
  }
}
