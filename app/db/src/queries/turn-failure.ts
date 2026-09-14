import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 28 — a turn that fails becomes something a person can see.
 *
 * Section 18.8: "On refusal, malformed output, timeout or exhausted tool
 * budget, save a failure state and use a bounded clarification or human task."
 *
 * The failure mode being designed against is silence. Every other way this
 * system can go wrong announces itself — a send fails and lands in the dead
 * queue, a tool refuses and the model is told why. A turn that produces
 * nothing produces nothing: no message, no error, no row. The customer sees a
 * business that did not reply, and the operator sees a conversation that looks
 * like every other one waiting for a customer.
 *
 * Distinct from `requestHandoff` on purpose, though the effect on the
 * conversation is nearly identical. That one is the model deciding a person is
 * needed, which is the system working. This one is the system not working, and
 * a turn that failed may not have been capable of deciding anything. They are
 * separate audit actions so the ten MVP metrics in step 32 can tell "the AI
 * asked for help" apart from "the AI broke" — two numbers that mean opposite
 * things about a pilot.
 */

export type TurnFailureKind =
  /** The model declined to answer. */
  | 'model_refused'
  /** Output arrived but could not be used. */
  | 'malformed_output'
  /** The model or the whole turn ran out of time. */
  | 'timeout'
  /** The turn spent its tool budget without producing a reply. */
  | 'tool_budget_exhausted'
  /** Neither a reply nor a tool call. */
  | 'no_output'
  /** The provider failed: a 500, a network error, an expired key. */
  | 'provider_error'

/** What a salesperson should do next, per failure. They are reading this cold. */
const NEXT_ACTION: Record<TurnFailureKind, string> = {
  model_refused: 'AI declined to answer — reply manually',
  malformed_output: 'AI output was unusable — reply manually',
  timeout: 'AI timed out — reply manually',
  tool_budget_exhausted: 'AI could not finish — reply manually',
  no_output: 'AI produced no reply — reply manually',
  provider_error: 'AI unavailable — reply manually',
}

const RECORD_FAILURE_SQL = `
with failed as (
  update conversations
  set handler_mode = 'human',
      next_action = $3,
      -- The customer is waiting with no reply at all, which is more urgent
      -- than an ordinary queued conversation. Never downgrade: 'urgent' was
      -- set by something that matters more than this, like an accident report.
      priority = case when priority = 'urgent' then 'urgent'::priority else 'high'::priority end,
      revision = revision + 1,
      updated_at = now()
  -- Idempotent in the same way a handoff is: a retried job that fails the same
  -- way must not produce a second task or a second revision.
  where id = $1 and operator_id = $2 and handler_mode = 'ai'
  returning id, operator_id, revision
),
cancelled as (
  update messages m
  set delivery_state = 'cancelled', error_code = 'turn_failed'
  from failed f
  where m.conversation_id = f.id
    and m.operator_id = f.operator_id
    and m.direction = 'outbound'
    and m.delivery_state = 'pending'
    and m.sent_by_membership_id is null
  returning m.id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, action, subject_type, subject_id, subject_version, data
  )
  select f.operator_id, 'ai', 'turn.failed', 'conversation', f.id, f.revision,
         jsonb_build_object(
           'kind', $4::text,
           'detail', $5::text,
           'message_id', $6::uuid,
           'cancelled_drafts', (select count(*) from cancelled)
         )
  from failed f
  returning id
)
select
  (select id from failed)                as conversation_id,
  (select revision from failed)          as revision,
  (select count(*)::int from cancelled)  as cancelled_drafts,
  (select handler_mode::text from conversations where id = $1 and operator_id = $2)
                                         as handler_mode_before
`

export type TurnFailureResult = {
  /** True for the call that created the task. A repeat is a harmless no-op. */
  raised: boolean
  /** True when a person already owned it, so no new task was needed. */
  alreadyWithAPerson: boolean
  cancelledDrafts: number
  revision: number | null
}

export async function recordTurnFailure(
  run: QueryRunner,
  input: {
    conversationId: string
    operatorId: string
    kind: TurnFailureKind
    /** The underlying reason, for the audit record. Never shown to a customer. */
    detail: string
    /** The inbound message the turn was answering. */
    messageId: string
  },
): Promise<TurnFailureResult> {
  const rows = await run(RECORD_FAILURE_SQL, [
    input.conversationId,
    input.operatorId,
    NEXT_ACTION[input.kind],
    input.kind,
    input.detail,
    input.messageId,
  ])
  const row = rows[0]
  const before = (row?.['handler_mode_before'] as string | null) ?? null
  const raised = row?.['conversation_id'] != null
  return {
    raised,
    alreadyWithAPerson: before === 'human',
    cancelledDrafts: Number(row?.['cancelled_drafts'] ?? 0),
    revision: raised ? Number(row?.['revision']) : null,
  }
}
