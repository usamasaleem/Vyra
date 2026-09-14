import type { QueryRunner } from '../runner.js'

/**
 * Recording that a customer asked not to be messaged again.
 *
 * `contacts.opted_out_at` existed before this and was read in four places —
 * the worker's handling decision, the dispatcher's eligibility check, the
 * inbox — and written in none. The column, the checks and the enum value were
 * all in place; nothing could turn it on. An agent promised silence and the
 * system kept no record of the promise.
 *
 * One statement, because the three parts must not come apart. A contact marked
 * opted out while an AI draft is still dispatchable is the exact failure this
 * exists to prevent, and it would be invisible: the flag would look set, and a
 * message would go out anyway.
 *
 * Handing the conversation to a person is the third part. Section 17.12 asks
 * for an acknowledgement, and the dispatcher refuses every automated send to
 * an opted-out contact — correctly — so the only route to one is a human who
 * can see what happened.
 */
const RECORD_OPT_OUT_SQL = `
with opted as (
  update contacts
  set opted_out_at = now()
  -- Idempotent: the second "stop" from someone already opted out changes
  -- nothing and leaves no second audit trail. The timestamp keeps meaning the
  -- moment they first asked.
  where id = $1 and operator_id = $2 and opted_out_at is null
  returning id, operator_id
),
paused as (
  update conversations c
  set handler_mode = 'human',
      next_action = 'Customer opted out of messages',
      revision = c.revision + 1,
      updated_at = now()
  from opted o
  where c.id = $3 and c.operator_id = o.operator_id
  returning c.id, c.revision
),
cancelled as (
  update messages m
  set delivery_state = 'cancelled', error_code = 'contact_opted_out'
  from opted o
  where m.operator_id = o.operator_id
    and m.direction = 'outbound'
    and m.delivery_state = 'pending'
  -- Every queued message to this contact, not only AI drafts and not only this
  -- conversation. A salesperson's unsent message is still a message to someone
  -- who has just asked for silence.
    and m.conversation_id in (
      select id from conversations where contact_id = o.id and operator_id = o.operator_id
    )
  returning m.id
),
chased as (
  -- Stop every scheduled chase. Continuing to follow up someone who asked for
  -- silence is the precise behaviour that gets a business number reported.
  update follow_ups f
  set state = 'cancelled', cancelled_reason = 'opted_out', cancelled_at = now(),
      updated_at = now()
  from opted o
  where f.operator_id = o.operator_id and f.state = 'scheduled'
    and f.conversation_id in (
      select id from conversations where contact_id = o.id and operator_id = o.operator_id
    )
  returning f.id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, action, subject_type, subject_id, subject_version, data
  )
  select o.operator_id, 'customer', 'contact.opted_out', 'contact', o.id,
         (select revision from paused),
         jsonb_build_object(
           'matched', $4::text,
           'message_id', $5::uuid,
           'cancelled_messages', (select count(*) from cancelled)
         )
  from opted o
  returning id
)
select
  (select id from opted)                  as contact_id,
  (select count(*)::int from cancelled)   as cancelled_messages,
  (select revision from paused)           as revision
`

export type OptOutResult = {
  /** True only for the call that recorded it. A repeat is a harmless no-op. */
  recorded: boolean
  /** Queued messages to this contact that were cancelled, across conversations. */
  cancelledMessages: number
  revision: number | null
}

export async function recordOptOut(
  run: QueryRunner,
  input: {
    contactId: string
    operatorId: string
    conversationId: string
    /** The phrase the rule matched, kept so a mistaken opt-out can be explained. */
    matched: string
    /** The message that carried it. */
    messageId: string
  },
): Promise<OptOutResult> {
  const rows = await run(RECORD_OPT_OUT_SQL, [
    input.contactId,
    input.operatorId,
    input.conversationId,
    input.matched,
    input.messageId,
  ])
  const row = rows[0]
  const recorded = row?.['contact_id'] != null
  return {
    recorded,
    cancelledMessages: Number(row?.['cancelled_messages'] ?? 0),
    revision: row?.['revision'] == null ? null : Number(row['revision']),
  }
}
