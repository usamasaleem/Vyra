import type { QueryRunner } from '../whatsapp/ingest'

/**
 * Build plan step 15 — the salesperson's working surface.
 *
 * Every query takes an operatorId and uses it. The inbox connects to Postgres
 * with a privileged role, exactly as the worker does, so row-level security
 * does not constrain these queries — the scoping here is the control, not a
 * belt-and-braces extra. The operatorId always comes from a verified
 * membership (see lib/auth.ts), never from anything the browser supplied.
 */

export type ConversationSummary = {
  id: string
  contactName: string | null
  channelIdentifier: string
  salesStage: string
  handlerMode: 'ai' | 'human'
  waitingReason: string
  bookingStatus: string
  priority: string
  ownerMembershipId: string | null
  ownerEmail: string | null
  lastCustomerMessageAt: Date | null
  lastMessageBody: string | null
  lastMessageDirection: 'inbound' | 'outbound' | null
  messageCount: number
  /** True when the customer spoke last and nobody has answered. */
  awaitingReply: boolean
}

const LIST_SQL = `
  select
    v.id, v.sales_stage, v.handler_mode, v.waiting_reason, v.booking_status,
    v.priority, v.owner_membership_id, v.last_customer_message_at,
    c.display_name, c.channel_identifier,
    last_message.body   as last_message_body,
    last_message.direction as last_message_direction,
    counts.n            as message_count
  from conversations v
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  left join lateral (
    select m.body, m.direction
    from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
      and m.delivery_state not in ('cancelled', 'failed')
    order by m.created_at desc
    limit 1
  ) last_message on true
  left join lateral (
    select count(*)::int as n
    from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
  ) counts on true
  where v.operator_id = $1
    and ($2::text is null or v.sales_stage::text = $2)
    and ($3::text is null or v.handler_mode::text = $3)
  order by v.last_customer_message_at desc nulls last
  limit $4
`

export async function listConversations(
  run: QueryRunner,
  operatorId: string,
  filters: { salesStage?: string | null; handlerMode?: string | null; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const rows = await run(LIST_SQL, [
    operatorId,
    filters.salesStage ?? null,
    filters.handlerMode ?? null,
    filters.limit ?? 50,
  ])

  return rows.map((r) => ({
    id: r['id'] as string,
    contactName: (r['display_name'] as string) ?? null,
    channelIdentifier: r['channel_identifier'] as string,
    salesStage: r['sales_stage'] as string,
    handlerMode: r['handler_mode'] as 'ai' | 'human',
    waitingReason: r['waiting_reason'] as string,
    bookingStatus: r['booking_status'] as string,
    priority: r['priority'] as string,
    ownerMembershipId: (r['owner_membership_id'] as string) ?? null,
    ownerEmail: null,
    lastCustomerMessageAt: toDateOrNull(r['last_customer_message_at']),
    lastMessageBody: (r['last_message_body'] as string) ?? null,
    lastMessageDirection: (r['last_message_direction'] as 'inbound' | 'outbound') ?? null,
    messageCount: Number(r['message_count'] ?? 0),
    awaitingReply: r['last_message_direction'] === 'inbound',
  }))
}

export type ThreadMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  kind: string
  body: string | null
  deliveryState: string
  errorCode: string | null
  sentByMembershipId: string | null
  createdAt: Date
}

export type ConversationThread = {
  id: string
  contactName: string | null
  channelIdentifier: string
  salesStage: string
  handlerMode: 'ai' | 'human'
  waitingReason: string
  bookingStatus: string
  priority: string
  revision: number
  ownerMembershipId: string | null
  lastCustomerMessageAt: Date | null
  optedOutAt: Date | null
  messages: ThreadMessage[]
}

const THREAD_SQL = `
  select v.id, v.sales_stage, v.handler_mode, v.waiting_reason, v.booking_status,
         v.priority, v.revision, v.owner_membership_id, v.last_customer_message_at,
         c.display_name, c.channel_identifier, c.opted_out_at
  from conversations v
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  where v.id = $1 and v.operator_id = $2
`

const MESSAGES_SQL = `
  select id, direction, kind, body, delivery_state, error_code,
         sent_by_membership_id, created_at
  from messages
  where conversation_id = $1 and operator_id = $2
  order by created_at
`

export async function getConversationThread(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<ConversationThread | null> {
  const rows = await run(THREAD_SQL, [conversationId, operatorId])
  const row = rows[0]
  // Another operator's conversation is not found, not forbidden: a different
  // answer would confirm that the id exists.
  if (row === undefined) return null

  const messages = await run(MESSAGES_SQL, [conversationId, operatorId])

  return {
    id: row['id'] as string,
    contactName: (row['display_name'] as string) ?? null,
    channelIdentifier: row['channel_identifier'] as string,
    salesStage: row['sales_stage'] as string,
    handlerMode: row['handler_mode'] as 'ai' | 'human',
    waitingReason: row['waiting_reason'] as string,
    bookingStatus: row['booking_status'] as string,
    priority: row['priority'] as string,
    revision: Number(row['revision']),
    ownerMembershipId: (row['owner_membership_id'] as string) ?? null,
    lastCustomerMessageAt: toDateOrNull(row['last_customer_message_at']),
    optedOutAt: toDateOrNull(row['opted_out_at']),
    messages: messages.map((m) => ({
      id: m['id'] as string,
      direction: m['direction'] as 'inbound' | 'outbound',
      kind: m['kind'] as string,
      body: (m['body'] as string) ?? null,
      deliveryState: m['delivery_state'] as string,
      errorCode: (m['error_code'] as string) ?? null,
      sentByMembershipId: (m['sent_by_membership_id'] as string) ?? null,
      createdAt: new Date(m['created_at'] as string),
    })),
  }
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(value as string)
}
