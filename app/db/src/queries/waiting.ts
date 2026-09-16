import type { QueryRunner } from '../runner.js'

/**
 * Customers waiting on a person who has not replied.
 *
 * The handoff queue answers "has anyone picked this up". Nothing answered "did
 * the person who picked it up actually reply", and the gap is where a customer
 * disappears: the agent hands over correctly, a salesperson accepts, the
 * customer asks one more question, and the AI is no longer allowed to answer it.
 * They get silence, and nothing in the system is counting.
 *
 * It happened three times in one evening of testing, and each time it looked
 * like a bug in the agent. It is not. It is the design working and nobody being
 * told.
 *
 * Derived rather than stored: a conversation a person owns whose last message
 * came from the customer is a conversation owing a reply. A column would be one
 * more thing to set correctly on every path, and would be wrong the first time
 * somebody forgot.
 */
export type WaitingCustomer = {
  conversationId: string
  operatorId: string
  contactName: string | null
  channelIdentifier: string
  waitingMinutes: number
  ownerMembershipId: string | null
  lastCustomerMessage: string | null
}

const WAITING_SQL = `
  select v.id as conversation_id, v.operator_id, v.owner_membership_id,
         c.display_name, c.channel_identifier,
         last_in.body as last_customer_message,
         round(extract(epoch from now() - last_in.created_at) / 60)::int as waiting_minutes
  from conversations v
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  join lateral (
    select body, created_at, direction from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
    order by m.created_at desc
    limit 1
  ) last_in on true
  where v.handler_mode = 'human'
    -- The last word was the customer's. Anything else means somebody answered.
    and last_in.direction = 'inbound'
    -- Somebody who asked not to be messaged is not waiting for a reply.
    and c.opted_out_at is null
    and ($1::uuid is null or v.operator_id = $1::uuid)
    and round(extract(epoch from now() - last_in.created_at) / 60)::int >= $2
  order by last_in.created_at
`

export async function listCustomersWaitingOnAPerson(
  run: QueryRunner,
  options: { operatorId?: string | null; minimumMinutes?: number } = {},
): Promise<WaitingCustomer[]> {
  const rows = await run(WAITING_SQL, [
    options.operatorId ?? null,
    options.minimumMinutes ?? 0,
  ])

  return rows.map((r) => ({
    conversationId: r['conversation_id'] as string,
    operatorId: r['operator_id'] as string,
    contactName: (r['display_name'] as string) ?? null,
    channelIdentifier: r['channel_identifier'] as string,
    waitingMinutes: Number(r['waiting_minutes']),
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
    lastCustomerMessage: (r['last_customer_message'] as string) ?? null,
  }))
}

/**
 * Put an ignored conversation back in the queue.
 *
 * A handoff somebody accepted stops being visible: it is theirs, and the queue
 * is for what nobody holds. That is right until they stop replying, at which
 * point "theirs" is indistinguishable from "lost" — and the customer cannot
 * tell the difference either.
 *
 * So an accepted handoff whose customer has been waiting past the operator's
 * own SLA goes back to `escalated`, where the existing queue already shows it
 * first and names the fallback owner. The owner is kept, not cleared: knowing
 * who let it go is part of what makes this worth recording.
 */
export type ReopenedConversation = {
  handoffId: string
  conversationId: string
  waitingMinutes: number
  /** Who dropped it. Kept on purpose — that is part of what this records. */
  ownerMembershipId: string | null
  /** Who was told they dropped it. */
  escalatedToMembershipId: string | null
}

export async function escalateAbandonedConversations(
  run: QueryRunner,
): Promise<ReopenedConversation[]> {
  const rows = await run(
    `with waiting as (
       select v.id as conversation_id, v.operator_id, o.handoff_sla_minutes,
              last_in.created_at as waiting_since
       from conversations v
       join operators o on o.id = v.operator_id
       join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
       join lateral (
         select created_at, direction from messages m
         where m.conversation_id = v.id and m.operator_id = v.operator_id
         order by m.created_at desc limit 1
       ) last_in on true
       where v.handler_mode = 'human' and last_in.direction = 'inbound'
         and c.opted_out_at is null
     )
     update handoffs h
     set state = 'escalated', escalated_at = now(), updated_at = now(),
         -- Named for the same reason as the overdue sweep: an escalation
         -- nobody is pointed at is indistinguishable from no escalation.
         -- The operator's choice, else the longest-standing active admin.
         escalated_to_membership_id = coalesce(
           (select op.fallback_owner_membership_id from operators op
             where op.id = h.operator_id),
           (select m.id from memberships m
             where m.operator_id = h.operator_id and m.active
             order by (m.role = 'admin') desc, (m.role = 'manager') desc, m.created_at
             limit 1))
     from waiting w
     where h.conversation_id = w.conversation_id
       and h.operator_id = w.operator_id
       and h.state = 'accepted'
       -- Past the operator's own SLA for a reply, measured from the message
       -- the customer is waiting on rather than from when it was accepted.
       and w.waiting_since < now() - make_interval(mins => w.handoff_sla_minutes)
     returning h.id, h.conversation_id, h.owner_membership_id,
               h.escalated_to_membership_id,
               round(extract(epoch from now() - w.waiting_since) / 60)::int as waiting_minutes`,
    [],
  )

  return rows.map((r) => ({
    handoffId: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    waitingMinutes: Number(r['waiting_minutes']),
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
    escalatedToMembershipId: (r['escalated_to_membership_id'] as string) ?? null,
  }))
}

/**
 * Taking a conversation back from a salesperson who stopped answering.
 *
 * Until now the only thing that happened to an abandoned conversation was an
 * escalation: the handoff was marked, a fallback owner was named in a log, and
 * the customer went on waiting. The pilot showed what that costs. A customer
 * asked about a discount at 17:35, was told a person would come back, and
 * thirty-five hours later had heard nothing — and nothing in the system was
 * ever going to speak to them again, because a conversation in human hands
 * schedules no follow-up. Follow-ups are scheduled by the turn, and the turn
 * does not run.
 *
 * So the agent takes it back. Deliberately narrow:
 *
 *   - Only when the customer is the one waiting. A conversation whose last
 *     message is the salesperson's is not silence, it is a reply.
 *   - Only past the operator's own threshold, and only if they set one.
 *   - Only for a message newer than the last handback, which is what stops an
 *     agent that replies and hands straight back from doing it in a loop.
 *   - Never for someone who has opted out.
 *
 * What it returns is the ability to reply, not the authority to decide. The
 * handoff stays open and whatever needed a person still needs one; the agent
 * is behind the same tool boundary it always was. The owner stays on the
 * conversation too — they are still who dropped it, and the inbox should say
 * so.
 */
export type ResumedConversation = {
  conversationId: string
  operatorId: string
  /** The unanswered customer message, re-queued so it actually gets a reply. */
  waitingMessageId: string
  waitingMinutes: number
  ownerMembershipId: string | null
}

const RESUME_ABANDONED_SQL = `
with waiting as (
  select v.id as conversation_id, v.operator_id, v.owner_membership_id,
         last.id as waiting_message_id, last.created_at as waiting_since
  from conversations v
  join operators o on o.id = v.operator_id
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  join lateral (
    select id, created_at, direction from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
    order by m.created_at desc limit 1
  ) last on true
  where v.handler_mode = 'human'
    and last.direction = 'inbound'
    and c.opted_out_at is null
    and o.ai_resumes_after_minutes is not null
    and last.created_at < now() - make_interval(mins => o.ai_resumes_after_minutes)
    -- The loop guard. A handback already made for this very message must not
    -- be made again, however many times the agent hands it back to a person.
    and (v.ai_resumed_at is null or v.ai_resumed_at < last.created_at)
),
resumed as (
  update conversations v
  set handler_mode = 'ai', revision = revision + 1, ai_resumed_at = now(), updated_at = now()
  from waiting w
  where v.id = w.conversation_id and v.operator_id = w.operator_id
  returning v.id, v.operator_id, v.revision
),
noted as (
  -- So the salesperson sees what happened rather than discovering it in the
  -- transcript. Author null: nobody wrote it, and attributing it to the person
  -- who went quiet would be worse than attributing it to no one.
  insert into conversation_notes (operator_id, conversation_id, author_membership_id, body)
  select r.operator_id, r.id, null,
         'The customer had been waiting ' ||
         round(extract(epoch from now() - w.waiting_since) / 60)::int ||
         ' minutes with no reply, so the agent has taken the conversation back. ' ||
         'Anything that needed a person still does — the handoff is still open.'
  from resumed r join waiting w on w.conversation_id = r.id
  returning id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, actor_id, action, subject_type, subject_id, subject_version, data
  )
  select r.operator_id, 'system', null, 'conversation.resumed_after_silence', 'conversation',
         r.id, r.revision,
         jsonb_build_object(
           'waiting_minutes', round(extract(epoch from now() - w.waiting_since) / 60)::int,
           'owner_membership_id', w.owner_membership_id
         )
  from resumed r join waiting w on w.conversation_id = r.id
  returning id
),
job as (
  -- The unanswered message, put back through the ordinary path. Everything
  -- that would have happened had a person never taken it now happens: the
  -- handling decision, the tool boundary, the revision check, the record.
  insert into outbox (operator_id, event_type, aggregate_id, payload)
  select r.operator_id, 'process_inbound_message', w.waiting_message_id,
         jsonb_build_object('message_id', w.waiting_message_id, 'conversation_id', r.id)
  from resumed r join waiting w on w.conversation_id = r.id
  returning id
)
select w.conversation_id, w.operator_id, w.waiting_message_id, w.owner_membership_id,
       round(extract(epoch from now() - w.waiting_since) / 60)::int as waiting_minutes
from waiting w join resumed r on r.id = w.conversation_id
`

export async function resumeAbandonedConversations(
  run: QueryRunner,
): Promise<ResumedConversation[]> {
  const rows = await run(RESUME_ABANDONED_SQL, [])
  return rows.map((r) => ({
    conversationId: r['conversation_id'] as string,
    operatorId: r['operator_id'] as string,
    waitingMessageId: r['waiting_message_id'] as string,
    waitingMinutes: Number(r['waiting_minutes'] ?? 0),
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
  }))
}
