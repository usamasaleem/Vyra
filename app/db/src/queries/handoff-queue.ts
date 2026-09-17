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
  /**
   * An open handoff already exists, so a second queue entry is not created —
   * one conversation is one job. But the new trigger may be more serious than
   * the one that opened it, and dropping it silently is how a salesperson ends
   * up reading "customer wants the highest-priced car" while the customer is
   * actually asking for a discount.
   *
   * So the existing entry is upgraded when the incoming reason outranks it, and
   * the new summary is appended rather than replacing the old one: both things
   * were asked, and whoever picks this up needs both.
   */
  on conflict (conversation_id) where state in ('waiting', 'escalated')
  do update set
    reason = case when public.vyra_priority_rank(excluded.priority::text)
                     < public.vyra_priority_rank(handoffs.priority::text)
                  then excluded.reason else handoffs.reason end,
    priority = case when public.vyra_priority_rank(excluded.priority::text)
                       < public.vyra_priority_rank(handoffs.priority::text)
                    then excluded.priority else handoffs.priority end,
    summary = case when handoffs.summary like '%' || excluded.summary || '%'
                   then handoffs.summary
                   else handoffs.summary || E'\n\n' || excluded.summary end,
    updated_at = now()
  -- xmax is zero on a fresh insert and non-zero when the row came back from a
  -- conflict, which is how "created" and "updated" stay distinguishable now
  -- that both return a row. Callers depend on that difference: a second trigger
  -- on an open conversation must not read as a new task in the queue.
  returning id, due_at, priority, (xmax = 0) as inserted
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
  (select id from raised)             as handoff_id,
  (select due_at from raised)         as due_at,
  (select priority::text from raised) as priority,
  (select inserted from raised)       as inserted
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
    // Open before this call: either nothing came back, or what came back was an
    // existing entry this trigger updated rather than a new one.
    alreadyOpen: handoffId === null || row?.['inserted'] === false,
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
  /** Who was told. Null only for an operator with no active members at all. */
  escalatedToMembershipId: string | null
  /**
   * True when the operator never named a fallback and we chose for them.
   *
   * Worth logging — the setting is still theirs to make — but no longer worth
   * panicking about, because somebody was told either way.
   */
  ownerWasImplied: boolean
}

/**
 * The person an escalation goes to.
 *
 * The operator's own choice first. Failing that, the longest-standing active
 * admin, because an operator cannot exist without the person who signed it up
 * and that person can always be found. `order by role = 'admin' desc` before
 * `created_at` so a manager is preferred over nobody but an admin over both.
 *
 * Deliberately not a stored default. Writing one at signup would be correct
 * exactly once and then drift every time the team changed; resolved at the
 * moment of escalation it is right for the team as it stands tonight.
 */
const FALLBACK_OWNER = `
  coalesce(
    op.fallback_owner_membership_id,
    (select m.id from memberships m
      where m.operator_id = op.id and m.active
      order by (m.role = 'admin') desc, (m.role = 'manager') desc, m.created_at
      limit 1)
  )`

/**
 * Handoffs nobody accepted in time.
 *
 * Escalating marks them and names the person to chase; it does not reassign.
 * Section 18.11 wants the queue item to stay visible, and silently handing it
 * to one person removes it from everyone else's view — which is the same
 * failure as nobody seeing it, with an extra step. So `owner_membership_id`
 * stays null and `escalated_to_membership_id` carries the name.
 *
 * Until tonight a null fallback owner was returned rather than resolved, on the
 * reasoning that an operator who never named one should learn it from a warning
 * in their logs rather than from a customer who waited all night. The pilot ran
 * both experiments at once and the log won: nobody configured a fallback,
 * nobody read the warning, and a customer who had been promised a person waited
 * forty-five hours. The setting was built, the checklist asked for it, and the
 * consequence of skipping it landed on the customer.
 *
 * An operator always has at least one active member. So now there is always
 * somebody to name, the choice is still the operator's to make, and skipping it
 * costs them a better answer rather than any answer at all.
 */
export async function escalateOverdueHandoffs(run: QueryRunner): Promise<Escalation[]> {
  const rows = await run(
    `with overdue as (
       update handoffs h
       set state = 'escalated', escalated_at = now(), updated_at = now(),
           escalated_to_membership_id = (
             select ${FALLBACK_OWNER} from operators op where op.id = h.operator_id
           )
       where h.state = 'waiting' and h.due_at < now()
       returning h.id, h.operator_id, h.conversation_id, h.summary,
                 h.priority, h.reason, h.due_at, h.escalated_to_membership_id
     ),
     audited as (
       insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
       select o.operator_id, 'system', 'handoff.escalated', 'handoff', o.id,
              jsonb_build_object('due_at', o.due_at,
                                 'escalated_to', o.escalated_to_membership_id)
       from overdue o
       returning id
     )
     select o.id, o.conversation_id, o.summary, o.priority::text as priority,
            o.reason::text as reason,
            extract(epoch from now() - o.due_at)::int / 60 as minutes_late,
            o.escalated_to_membership_id,
            op.fallback_owner_membership_id is null as owner_was_implied
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
    escalatedToMembershipId: (r['escalated_to_membership_id'] as string) ?? null,
    ownerWasImplied: r['owner_was_implied'] === true,
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

export type QueuedHandoff = {
  id: string
  conversationId: string
  reason: string
  summary: string
  priority: string
  state: string
  dueAt: Date
  /** Negative once it is late. The queue's whole point is that this goes negative. */
  minutesRemaining: number
  escalatedAt: Date | null
  ownerMembershipId: string | null
  /** Who the escalation named. Read with `escalatedAt`, not on its own. */
  escalatedToMembershipId: string | null
  customerName: string | null
  whatsappNumber: string
  /** The customer's last message, so the queue can be read without opening each one. */
  lastCustomerMessage: string | null
  waitingSinceMinutes: number
}

/**
 * The shared queue: everything open, worst first.
 *
 * Escalated before waiting, because an item that already blew its SLA is a
 * worse fact than an urgent one that has ten minutes left. Within that,
 * priority, then oldest — a conversation that has been waiting an hour should
 * not sit under one that arrived a minute ago at the same priority.
 */
const QUEUE_SQL = `
  select h.id, h.conversation_id, h.reason::text as reason, h.summary,
         h.priority::text as priority, h.state::text as state, h.due_at,
         h.escalated_at, h.owner_membership_id, h.escalated_to_membership_id,
         extract(epoch from h.due_at - now())::int / 60 as minutes_remaining,
         extract(epoch from now() - h.created_at)::int / 60 as waiting_since_minutes,
         c.display_name, c.channel_identifier,
         last_in.body as last_customer_message
  from handoffs h
  join conversations v on v.id = h.conversation_id and v.operator_id = h.operator_id
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  left join lateral (
    select m.body from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
      and m.direction = 'inbound' and m.body is not null
    order by m.created_at desc limit 1
  ) last_in on true
  where h.operator_id = $1
    -- Open means unresolved, which includes accepted. A salesperson needs to
    -- see what they picked up and have not finished; the unclaimed filter is
    -- what narrows it to the shared pile.
    and h.state in ('waiting', 'escalated', 'accepted')
    and ($2::boolean is not true or h.owner_membership_id is null)
  order by
    (h.state = 'escalated') desc,
    -- Unclaimed above accepted at the same priority: nobody is looking at the
    -- unclaimed ones.
    (h.owner_membership_id is not null),
    case h.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    h.created_at
  limit $3
`

export async function listOpenHandoffs(
  run: QueryRunner,
  operatorId: string,
  options: { unclaimedOnly?: boolean; limit?: number } = {},
): Promise<QueuedHandoff[]> {
  const rows = await run(QUEUE_SQL, [
    operatorId,
    options.unclaimedOnly ?? false,
    options.limit ?? 50,
  ])

  return rows.map((r) => ({
    id: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    reason: r['reason'] as string,
    summary: r['summary'] as string,
    priority: r['priority'] as string,
    state: r['state'] as string,
    dueAt: new Date(r['due_at'] as string),
    minutesRemaining: Number(r['minutes_remaining'] ?? 0),
    escalatedAt: r['escalated_at'] == null ? null : new Date(r['escalated_at'] as string),
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
    escalatedToMembershipId: (r['escalated_to_membership_id'] as string) ?? null,
    customerName: (r['display_name'] as string) ?? null,
    whatsappNumber: r['channel_identifier'] as string,
    lastCustomerMessage: (r['last_customer_message'] as string) ?? null,
    waitingSinceMinutes: Number(r['waiting_since_minutes'] ?? 0),
  }))
}

/**
 * A customer writing into a conversation nobody has picked up yet.
 *
 * "I've connected you with an agent" is the last thing this system said to a
 * real customer before they asked which colours were available, then "??",
 * then "Hi?", then to change their dates, then who runs the company — five
 * messages into five minutes of nothing, while `ai_resumes_after_minutes`
 * counted down.
 *
 * Deliberately only `waiting` and `escalated`, and only while nobody owns it.
 * An accepted handoff is a person who is present, and a machine talking over
 * a salesperson mid-sentence is worse than the silence — section 10's "one
 * handler at a time" is about exactly that. This is the case where the
 * handler does not exist yet.
 */
export async function unclaimedHandoffFor(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string },
): Promise<{ handoffId: string; dueAt: Date } | null> {
  const rows = await run(
    `select id, due_at from handoffs
     where conversation_id = $1 and operator_id = $2
       and state in ('waiting', 'escalated')
       and owner_membership_id is null
     order by created_at desc
     limit 1`,
    [input.conversationId, input.operatorId],
  )
  const row = rows[0]
  return row === undefined
    ? null
    : { handoffId: row['id'] as string, dueAt: new Date(row['due_at'] as string) }
}
