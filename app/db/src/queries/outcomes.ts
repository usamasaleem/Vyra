import type { QueryRunner } from '../runner.js'

/**
 * The two measures a machine cannot produce.
 *
 * Section 15 asks for lost reasons and an incorrect-answer count. Neither can
 * be derived from anything the system already records: only a person knows the
 * customer went with a cheaper company, and only a person knows the agent said
 * something untrue. Both had columns or counts in the reporting list and no way
 * to fill them, which made four of the ten measures unmeasurable.
 */

/** The reasons a Dubai rental lead dies. Closed, so the numbers can be added up. */
export const LOST_REASONS = [
  'price',
  'availability',
  'vehicle_not_available',
  'too_slow',
  'went_elsewhere',
  'not_eligible',
  'no_response',
  'not_serious',
  'other',
] as const

export type LostReason = (typeof LOST_REASONS)[number]

/**
 * Closing a lead.
 *
 * A lost lead requires a reason and a won one does not, because "why did we
 * lose it" is the question the report exists to answer and "why did we win"
 * is not on the list. Free text is allowed alongside the category — the
 * category makes it countable, the note makes it useful.
 */
export async function closeLead(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    membershipId: string
    outcome: 'won' | 'lost'
    reason?: LostReason | null
    note?: string | null
  },
): Promise<{ closed: boolean }> {
  const rows = await run(
    `with closed as (
       update conversations
       set sales_stage = $3::sales_stage,
           lost_reason = case when $3 = 'lost' then $4 else null end,
           next_action = null,
           updated_at = now()
       where id = $1 and operator_id = $2 and sales_stage not in ('won', 'lost')
       returning id, operator_id
     ),
     chased as (
       -- Section 11: stop automation after a win or a loss. A closed lead that
       -- keeps getting chased is the most embarrassing message this system
       -- could send.
       update follow_ups f
       set state = 'cancelled', cancelled_reason = $3, cancelled_at = now(), updated_at = now()
       from closed c
       where f.conversation_id = c.id and f.operator_id = c.operator_id and f.state = 'scheduled'
       returning f.id
     ),
     handed as (
       update handoffs h
       set state = 'resolved', resolved_at = now(), resolution = $3, updated_at = now()
       from closed c
       where h.conversation_id = c.id and h.operator_id = c.operator_id
         and h.state in ('waiting', 'accepted', 'escalated')
       returning h.id
     ),
     audited as (
       insert into audit_events (
         operator_id, actor_type, actor_id, action, subject_type, subject_id, data
       )
       select c.operator_id, 'user', $5, 'lead.' || $3, 'conversation', c.id,
              jsonb_build_object('reason', $4::text, 'note', $6::text)
       from closed c
       returning id
     )
     select (select id from closed) as id`,
    [
      input.conversationId, input.operatorId, input.outcome,
      input.outcome === 'lost' ? (input.reason ?? 'other') : null,
      input.membershipId, input.note ?? null,
    ],
  )
  return { closed: rows[0]?.['id'] != null }
}

/**
 * A salesperson marking something the agent said as wrong.
 *
 * Section 15 counts incorrect answers, and nothing else in this system can
 * detect one. Every safety mechanism prevents a *category* of error — an
 * invented price, an unverified availability claim — and none of them notices
 * a reply that is fluent, allowed, and untrue.
 *
 * Recorded against the message so the exact wording survives, and audited so
 * the count cannot be quietly revised later.
 */
export async function flagIncorrectAnswer(
  run: QueryRunner,
  input: {
    operatorId: string
    messageId: string
    membershipId: string
    note: string
  },
): Promise<{ flagged: boolean }> {
  const rows = await run(
    `with flagged as (
       select m.id, m.operator_id, m.conversation_id, m.body
       from messages m
       where m.id = $1 and m.operator_id = $2 and m.direction = 'outbound'
     ),
     audited as (
       insert into audit_events (
         operator_id, actor_type, actor_id, action, subject_type, subject_id, data
       )
       select f.operator_id, 'user', $3, 'answer.flagged_incorrect', 'message', f.id,
              jsonb_build_object('note', $4::text, 'body', f.body,
                                 'conversation_id', f.conversation_id)
       from flagged f
       returning id
     )
     select (select id from audited) as id`,
    [input.messageId, input.operatorId, input.membershipId, input.note],
  )
  return { flagged: rows[0]?.['id'] != null }
}
