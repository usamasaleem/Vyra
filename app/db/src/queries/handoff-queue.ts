import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 29 — the handoff as a task somebody owns.
 *
 * Section 18.11: "a generated handoff summary without an assigned task is not a
 * completed handoff". Stopping the AI is the urgent half and was already done;
 * this is the half where a person is actually expected to act, with a clock on
 * it and somewhere for it to go when nobody does.
 */

export type HandoffReason =
  | 'customer_asked'
  | 'qualified_lead'
  | 'discount_requested'
  | 'cannot_verify'
  | 'payment_or_dispute'
  | 'safety_or_accident'
  | 'non_text_message'
  | 'agent_uncertain'
  | 'turn_failed'

/**
 * How urgent each reason is before anyone reads it.
 *
 * Decided here rather than by a model, because it is a policy judgement and
 * because a model asked to rank its own escalations will drift. An accident is
 * urgent whatever else is in the conversation; a well-qualified lead is not,
 * however keen the customer sounded.
 */
const PRIORITY_FOR: Record<HandoffReason, string> = {
  safety_or_accident: 'urgent',
  payment_or_dispute: 'urgent',
  customer_asked: 'high',
  discount_requested: 'high',
  turn_failed: 'high',
  non_text_message: 'normal',
  cannot_verify: 'normal',
  agent_uncertain: 'normal',
  qualified_lead: 'normal',
}

export type RaisedHandoff = {
  /** Null when an open handoff already existed — the repeat is not a new task. */
  handoffId: string | null
  alreadyOpen: boolean
  dueAt: Date | null
  priority: string
}

/**
 * One statement, and the partial unique index does the deduplication.
 *
 * Two messages in a burst must not raise two tasks for one conversation: a
 * salesperson would accept one while the other quietly escalated behind them.
 * `on conflict do nothing` against `handoffs_one_open_per_conversation` makes
 * the second call a no-op rather than a race.
 */
const RAISE_SQL = `
with raised as (
  insert into handoffs (
    operator_id, conversation_id, reason, summary, priority, due_at, trigger_message_id
  )
  select $1, $2, $3::handoff_reason, $4, $5::priority,
         now() + make_interval(mins => o.handoff_sla_minutes), $6::uuid
  from operators o
  where o.id = $1
  on conflict do nothing
  returning id, due_at, priority
),
audited as (
  insert into audit_events (
    operator_id, actor_type, action, subject_type, subject_id, data
  )
  select $1, 'ai', 'handoff.raised', 'handoff', r.id,
         jsonb_build_object('reason', $3::text, 'conversation_id', $2::uuid, 'due_at', r.due_at)
  from raised r
  returning id
)
select
  (select id from raised)            as handoff_id,
  (select due_at from raised)        as due_at,
  (select priority::text from raised) as priority
`

export async function raiseHandoff(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    reason: HandoffReason
    /** The sentence a salesperson reads first in the queue. */
    summary: string
    triggerMessageId?: string | null
  },
): Promise<RaisedHandoff> {
  const priority = PRIORITY_FOR[input.reason]
  const rows = await run(RAISE_SQL, [
    input.operatorId,
    input.conversationId,
    input.reason,
    input.summary,
    priority,
    input.triggerMessageId ?? null,
  ])
  const row = rows[0]
  const handoffId = (row?.['handoff_id'] as string) ?? null

  return {
    handoffId,
    alreadyOpen: handoffId === null,
    dueAt: row?.['due_at'] == null ? null : new Date(row['due_at'] as string),
    priority,
  }
}

/**
 * A salesperson taking the work.
 *
 * Guarded on `state = 'waiting' or 'escalated'` so two people clicking Accept
 * cannot both own it — the second finds nothing to update and is told someone
 * beat them, rather than silently taking it from under them.
 */
export async function acceptHandoff(
  run: QueryRunner,
  input: { handoffId: string; operatorId: string; membershipId: string },
): Promise<{ accepted: boolean; takenBy: string | null }> {
  const rows = await run(
    `with taken as (
       update handoffs
       set state = 'accepted', owner_membership_id = $3, accepted_at = now(), updated_at = now()
       where id = $1 and operator_id = $2 and state in ('waiting', 'escalated')
       returning id, conversation_id, operator_id
     ),
     assigned as (
       -- The conversation follows the task. A handoff accepted by someone who
       -- does not then own the conversation is a task with no authority.
       update conversations c
       set owner_membership_id = $3, updated_at = now()
       from taken t where c.id = t.conversation_id and c.operator_id = t.operator_id
       returning c.id
     ),
     audited as (
       insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id)
       select t.operator_id, 'user', $3, 'handoff.accepted', 'handoff', t.id from taken t
       returning id
     )
     select (select id from taken) as taken_id,
            (select owner_membership_id::text from handoffs where id = $1) as current_owner`,
    [input.handoffId, input.operatorId, input.membershipId],
  )
  const row = rows[0]
  const accepted = row?.['taken_id'] != null
  return { accepted, takenBy: accepted ? input.membershipId : ((row?.['current_owner'] as string) ?? null) }
}

export type Escalation = {
  handoffId: string
  conversationId: string
  summary: string
  priority: string
  reason: string
  minutesLate: number
  /** Null when the operator has not named one — the caller must say so loudly. */
  fallbackOwnerMembershipId: string | null
}

/**
 * Handoffs nobody accepted in time.
 *
 * Escalating marks them and names the fallback owner; it does not reassign.
 * Section 18.11 wants the queue item to stay visible, and silently handing it
 * to one person removes it from everyone else's view — which is the same
 * failure as nobody seeing it, with an extra step.
 *
 * A null fallback owner is returned rather than skipped. An operator who never
 * named one should learn it from a warning in their logs, not from a customer
 * who waited all night.
 */
export async function escalateOverdueHandoffs(run: QueryRunner): Promise<Escalation[]> {
  const rows = await run(
    `with overdue as (
       update handoffs h
       set state = 'escalated', escalated_at = now(), updated_at = now()
       where h.state = 'waiting' and h.due_at < now()
       returning h.id, h.operator_id, h.conversation_id, h.summary,
                 h.priority, h.reason, h.due_at
     ),
     audited as (
       insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
       select o.operator_id, 'system', 'handoff.escalated', 'handoff', o.id,
              jsonb_build_object('due_at', o.due_at)
       from overdue o
       returning id
     )
     select o.id, o.conversation_id, o.summary, o.priority::text as priority,
            o.reason::text as reason,
            extract(epoch from now() - o.due_at)::int / 60 as minutes_late,
            op.fallback_owner_membership_id
     from overdue o
     join operators op on op.id = o.operator_id`,
    [],
  )

  return rows.map((r) => ({
    handoffId: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    summary: r['summary'] as string,
    priority: r['priority'] as string,
    reason: r['reason'] as string,
    minutesLate: Number(r['minutes_late'] ?? 0),
    fallbackOwnerMembershipId: (r['fallback_owner_membership_id'] as string) ?? null,
  }))
}

/** Closing a handoff, whether it was handled or the customer went quiet. */
export async function resolveHandoff(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; resolution: string },
): Promise<{ resolved: number }> {
  const rows = await run(
    `update handoffs
     set state = 'resolved', resolved_at = now(), resolution = $3, updated_at = now()
     where conversation_id = $1 and operator_id = $2 and state in ('waiting', 'accepted', 'escalated')
     returning id`,
    [input.conversationId, input.operatorId, input.resolution],
  )
  return { resolved: rows.length }
}
