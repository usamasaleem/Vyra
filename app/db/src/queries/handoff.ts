import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 24 — the backing query for the `request_handoff` tool.
 *
 * Section 18.8 gives this tool two mandatory checks: the task must be
 * idempotent, and it must pause sending. Both are here rather than in the tool
 * wrapper, because a check the caller can forget to run is not a check.
 *
 * This is deliberately not `takeOverConversation`. That one records a
 * salesperson deciding to step in, and needs their membership id. This records
 * the AI stepping *out*, which nobody has accepted yet — the owner stays null
 * until a person takes it in step 29. The actor is `ai`, and the audit trail
 * should not claim a human made this decision.
 */
const REQUEST_HANDOFF_SQL = `
with paused as (
  update conversations
  set handler_mode = 'human',
      next_action = $3,
      revision = revision + 1,
      updated_at = now()
  -- Idempotency lives in this predicate. A second call finds the row already
  -- human-owned and updates nothing: no second revision bump, no second audit
  -- event, no second cancellation sweep. Under READ COMMITTED an UPDATE
  -- re-evaluates its WHERE clause after taking the row lock, so two concurrent
  -- calls cannot both pass it.
  where id = $1 and operator_id = $2 and handler_mode = 'ai'
  returning id, operator_id, revision
),
cancelled as (
  update messages m
  set delivery_state = 'cancelled', error_code = 'handoff_requested'
  from paused p
  where m.conversation_id = p.id
    and m.operator_id = p.operator_id
    and m.direction = 'outbound'
    and m.delivery_state = 'pending'
    -- Only AI drafts. A salesperson's own queued message still stands.
    and m.sent_by_membership_id is null
  returning m.id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, action, subject_type, subject_id, subject_version, data
  )
  select p.operator_id, 'ai', 'conversation.handoff_requested', 'conversation', p.id, p.revision,
         jsonb_build_object('reason', $3::text, 'cancelled_drafts', (select count(*) from cancelled))
  from paused p
  returning id
)
select
  (select revision from paused)            as revision,
  (select count(*)::int from cancelled)    as cancelled_drafts,
  (select id from paused)                  as conversation_id,
  -- Read against the statement snapshot, so this is the mode as it was *before*
  -- the update above — which is exactly the question being asked: was this
  -- conversation already in human hands when the model asked for a handoff?
  (select handler_mode::text from conversations where id = $1 and operator_id = $2)
                                           as handler_mode_before
`

export type HandoffResult = {
  /** True only for the call that actually paused sending. */
  paused: boolean
  /** True when the conversation was already human-owned — a harmless repeat. */
  alreadyHuman: boolean
  /** False when no such conversation exists for this operator. */
  found: boolean
  revision: number | null
  cancelledDrafts: number
}

export async function requestHandoff(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; reason: string },
): Promise<HandoffResult> {
  const rows = await run(REQUEST_HANDOFF_SQL, [
    input.conversationId,
    input.operatorId,
    input.reason,
  ])
  const row = rows[0]
  const before = (row?.['handler_mode_before'] as string | null) ?? null
  const paused = row?.['conversation_id'] != null
  return {
    paused,
    alreadyHuman: before === 'human',
    found: before !== null,
    revision: paused ? Number(row?.['revision']) : null,
    cancelledDrafts: Number(row?.['cancelled_drafts'] ?? 0),
  }
}
