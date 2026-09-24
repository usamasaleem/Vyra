import type { QueryRunner } from './relay.js'

/**
 * Build plan step 10 — what the worker loads before it does anything.
 *
 * Section 18.7: background jobs receive internal ids and reload trusted
 * records. They do not inherit authorization from the job payload. So the job
 * carries a message id, and everything else is read fresh from the database.
 *
 * Every join below repeats `operator_id`. That is not redundant. The worker
 * connects with a privileged role and therefore bypasses row-level security —
 * RLS protects the browser path, not this one. Explicit scoping in each join
 * is the only thing preventing a cross-operator read here, and TECH-STACK.md
 * names this as the most likely place for a tenant leak.
 */

export type ConversationContext = {
  operator: {
    id: string
    name: string
    timezone: string
    /** Raw; readServiceHours validates it. Null until somebody sets it. */
    serviceHours: unknown
    responseExpectation: string | null
    /** Where the whole fleet can be seen, for a customer the thread cannot hold. */
    websiteUrl: string | null
    aiSendingEnabled: boolean
    /**
     * Whether the agent may settle a booking itself.
     *
     * The prompt used to say "you cannot book anything yourself" flatly, and
     * the buttons offered "Confirm with team", both written when that was
     * true of everybody. An operator who has switched auto-confirm on is
     * then read a rule that no longer applies: the agent asks permission to
     * do the thing it is about to do, which is the round trip the setting
     * exists to remove.
     *
     * Both halves, because confirming without a calendar the operator vouches
     * for is the one case the booking path refuses anyway.
     */
    mayConfirmBookings: boolean
    /** How long the agent may hold a car for somebody deciding; null when it does not. */
    holdMinutes: number | null
    /** Money off the agent may give by itself when the price is the objection. */
    discountTiers: Array<{ minDays: number; percent: number }>
    /** Extras the agent may add to a booking, at the operator's price. */
    addOns: Array<{ id: string; name: string; priceMinor: number; per: 'day' | 'rental' }>
    policyVersion: number
  }
  conversation: {
    id: string
    revision: number
    handlerMode: 'ai' | 'human'
    salesStage: string
    waitingReason: string
    bookingStatus: string
    ownerMembershipId: string | null
    lastCustomerMessageAt: Date | null
    /** What happened before the recent window, or null if nothing has fallen out. */
    summary: string | null
    summaryThroughCount: number
  }
  contact: {
    id: string
    channelIdentifier: string
    displayName: string | null
    optedOutAt: Date | null
  }
  message: {
    id: string
    kind: string
    body: string | null
    providerId: string | null
    providerTimestamp: Date | null
  }
  /** Oldest first, so it reads as a transcript. */
  recentMessages: Array<{
    direction: 'inbound' | 'outbound'
    kind: string
    body: string | null
    createdAt: Date
  }>
}

const CONTEXT_SQL = `
  select
    o.id as operator_id, o.name as operator_name, o.timezone, o.website_url, o.service_hours,
    o.response_expectation, o.ai_sending_enabled, o.policy_version,
    o.auto_confirm_bookings, o.availability_calendar_complete, o.hold_minutes, o.discount_tiers,
    o.add_ons,
    v.id as conversation_id, v.revision, v.handler_mode, v.sales_stage,
    v.summary, v.summary_through_count,
    v.waiting_reason, v.booking_status, v.owner_membership_id,
    v.last_customer_message_at,
    c.id as contact_id, c.channel_identifier, c.display_name, c.opted_out_at,
    m.id as message_id, m.kind, m.body, m.provider_id, m.provider_timestamp
  from messages m
  join conversations v on v.id = m.conversation_id and v.operator_id = m.operator_id
  join contacts c on c.id = v.contact_id and c.operator_id = m.operator_id
  join operators o on o.id = m.operator_id
  where m.id = $1
`

const RECENT_MESSAGES_SQL = `
  select direction, kind, body, created_at
  from messages
  where conversation_id = $1 and operator_id = $2
  order by created_at desc
  limit $3
`

/**
 * Two queries rather than one.
 *
 * The webhook is written as a single statement because it is on the customer's
 * latency path and the database is ~170ms away. This is background work behind
 * a queue, where clarity is worth more than a round trip.
 */
export async function loadConversationContext(
  run: QueryRunner,
  messageId: string,
  options: { recentMessageLimit?: number } = {},
): Promise<ConversationContext | null> {
  const rows = await run(CONTEXT_SQL, [messageId])
  const row = rows[0]
  if (row === undefined) return null

  const operatorId = row['operator_id'] as string
  const conversationId = row['conversation_id'] as string

  const recent = await run(RECENT_MESSAGES_SQL, [
    conversationId,
    operatorId,
    options.recentMessageLimit ?? 20,
  ])

  return {
    operator: {
      id: operatorId,
      name: row['operator_name'] as string,
      timezone: row['timezone'] as string,
      serviceHours: row['service_hours'] ?? null,
      websiteUrl: (row['website_url'] as string) ?? null,
      responseExpectation: (row['response_expectation'] as string) ?? null,
      aiSendingEnabled: row['ai_sending_enabled'] === true,
      mayConfirmBookings: row['auto_confirm_bookings'] === true
        && row['availability_calendar_complete'] === true,
      // Only where the calendar can be trusted: a hold on a car nobody knows
      // is free is a promise with nothing under it.
      holdMinutes: row['hold_minutes'] != null && row['availability_calendar_complete'] === true
        ? Number(row['hold_minutes']) : null,
      discountTiers: (row['discount_tiers'] as Array<{ minDays: number; percent: number }> | null) ?? [],
      addOns: (row['add_ons'] as Array<{ id: string; name: string; priceMinor: number; per: 'day' | 'rental' }> | null) ?? [],
      policyVersion: Number(row['policy_version']),
    },
    conversation: {
      id: conversationId,
      revision: Number(row['revision']),
      summary: (row['summary'] as string) ?? null,
      summaryThroughCount: Number(row['summary_through_count'] ?? 0),
      handlerMode: row['handler_mode'] as 'ai' | 'human',
      salesStage: row['sales_stage'] as string,
      waitingReason: row['waiting_reason'] as string,
      bookingStatus: row['booking_status'] as string,
      ownerMembershipId: (row['owner_membership_id'] as string) ?? null,
      lastCustomerMessageAt: toDateOrNull(row['last_customer_message_at']),
    },
    contact: {
      id: row['contact_id'] as string,
      channelIdentifier: row['channel_identifier'] as string,
      displayName: (row['display_name'] as string) ?? null,
      optedOutAt: toDateOrNull(row['opted_out_at']),
    },
    message: {
      id: row['message_id'] as string,
      kind: row['kind'] as string,
      body: (row['body'] as string) ?? null,
      providerId: (row['provider_id'] as string) ?? null,
      providerTimestamp: toDateOrNull(row['provider_timestamp']),
    },
    // Reversed: the query takes the newest for the limit, the caller wants a
    // transcript.
    recentMessages: recent.reverse().map((m) => ({
      direction: m['direction'] as 'inbound' | 'outbound',
      kind: m['kind'] as string,
      body: (m['body'] as string) ?? null,
      createdAt: new Date(m['created_at'] as string),
    })),
  }
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(value as string)
}
