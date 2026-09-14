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
  ownerMembershipId: string | null
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
     set state = 'escalated', escalated_at = now(), updated_at = now()
     from waiting w
     where h.conversation_id = w.conversation_id
       and h.operator_id = w.operator_id
       and h.state = 'accepted'
       -- Past the operator's own SLA for a reply, measured from the message
       -- the customer is waiting on rather than from when it was accepted.
       and w.waiting_since < now() - make_interval(mins => w.handoff_sla_minutes)
     returning h.id, h.conversation_id, h.owner_membership_id,
               round(extract(epoch from now() - w.waiting_since) / 60)::int as waiting_minutes`,
    [],
  )

  return rows.map((r) => ({
    handoffId: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    waitingMinutes: Number(r['waiting_minutes']),
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
  }))
}
