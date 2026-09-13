/**
 * Build plan step 8 — save before acknowledging.
 *
 * The SQL is written once here as plain text with positional parameters so the
 * exact statement that runs in production can also run in tests. A test that
 * exercises a different query than production is not a test of production.
 */

export type { QueryRunner } from '@vyra/db'
import type { QueryRunner } from '@vyra/db'

export type IngestOutcome = {
  /** False when no active whatsapp_account matches the receiving number. */
  accountFound: boolean
  /** True when this provider event was already stored. Nothing was written. */
  duplicate: boolean
  eventId: string | null
  contactId: string | null
  conversationId: string | null
  messageId: string | null
  outboxId: string | null
}

export type InboundMessageInput = {
  phoneNumberId: string
  providerEventKey: string
  rawPayload: unknown
  waId: string
  profileName: string | null
  providerMessageId: string
  kind: string
  body: string | null
  media: unknown | null
  sentAt: Date
}

/**
 * One statement, which matters twice over.
 *
 * Correctness: a single statement is atomic without an explicit transaction.
 * Either the event, contact, conversation, message and outbox row all exist,
 * or none do. There is no state in which we acknowledged a message we did not
 * store.
 *
 * Cost: the pilot database is ~170ms away, so BEGIN + four inserts + COMMIT
 * would be six round trips and about a second — the entire p95 budget section
 * 18.15 allows for durable acceptance. This is one round trip.
 *
 * Deduplication falls out of the structure rather than being checked for. If
 * the event key exists, the first CTE returns no rows, every dependent CTE
 * therefore inserts nothing, and the statement reports a duplicate. A
 * redelivered webhook cannot produce a second message, conversation or job.
 */
const INBOUND_MESSAGE_SQL = `
with account as (
  select id as account_id, operator_id
  from whatsapp_accounts
  where phone_number_id = $1 and active
),
event as (
  insert into inbound_events (operator_id, whatsapp_account_id, provider_event_key, payload)
  select operator_id, account_id, $2, $3::jsonb
  from account
  on conflict (whatsapp_account_id, provider_event_key) do nothing
  returning id, operator_id, whatsapp_account_id
),
contact as (
  insert into contacts (operator_id, channel_identifier, display_name)
  select e.operator_id, $4, $5
  from event e
  on conflict (operator_id, channel_identifier) do update
    set display_name = coalesce(excluded.display_name, contacts.display_name),
        updated_at = now()
  returning id, operator_id
),
conversation as (
  insert into conversations (operator_id, contact_id, whatsapp_account_id, last_customer_message_at)
  select c.operator_id, c.id, e.whatsapp_account_id, $6::timestamptz
  from contact c join event e on e.operator_id = c.operator_id
  on conflict (operator_id, contact_id) do update
    set last_customer_message_at = excluded.last_customer_message_at,
        updated_at = now()
  returning id, operator_id
),
message as (
  insert into messages (
    operator_id, conversation_id, direction, kind, provider_id,
    body, media, delivery_state, provider_timestamp
  )
  select v.operator_id, v.id, 'inbound', $7::message_kind, $8, $9, $10::jsonb, 'delivered', $6::timestamptz
  from conversation v
  on conflict do nothing
  returning id, operator_id, conversation_id
),
job as (
  insert into outbox (operator_id, event_type, aggregate_id, payload)
  select m.operator_id, 'process_inbound_message', m.id,
         jsonb_build_object('message_id', m.id, 'conversation_id', m.conversation_id)
  from message m
  returning id
)
select
  (select account_id from account)  as account_id,
  (select id from event)            as event_id,
  (select id from contact)          as contact_id,
  (select id from conversation)     as conversation_id,
  (select id from message)          as message_id,
  (select id from job)              as outbox_id
`

export async function storeInboundMessage(
  run: QueryRunner,
  input: InboundMessageInput,
): Promise<IngestOutcome> {
  const rows = await run(INBOUND_MESSAGE_SQL, [
    input.phoneNumberId,
    input.providerEventKey,
    JSON.stringify(input.rawPayload),
    input.waId,
    input.profileName,
    input.sentAt.toISOString(),
    input.kind,
    input.providerMessageId,
    input.body,
    input.media === null ? null : JSON.stringify(input.media),
  ])

  const row = rows[0]
  const accountFound = row?.account_id != null
  return {
    accountFound,
    duplicate: accountFound && row?.event_id == null,
    eventId: (row?.event_id as string) ?? null,
    contactId: (row?.contact_id as string) ?? null,
    conversationId: (row?.conversation_id as string) ?? null,
    messageId: (row?.message_id as string) ?? null,
    outboxId: (row?.outbox_id as string) ?? null,
  }
}

/**
 * Delivery receipts and any other non-message change.
 *
 * Stored but not yet interpreted — reconciling provider delivery state against
 * our own is step 11's job. Storing them now means the record exists when that
 * arrives, rather than a gap where the receipts used to be.
 */
const INBOUND_EVENT_ONLY_SQL = `
with account as (
  select id as account_id, operator_id
  from whatsapp_accounts
  where phone_number_id = $1 and active
),
event as (
  insert into inbound_events (operator_id, whatsapp_account_id, provider_event_key, payload)
  select operator_id, account_id, $2, $3::jsonb
  from account
  on conflict (whatsapp_account_id, provider_event_key) do nothing
  returning id
)
select (select account_id from account) as account_id, (select id from event) as event_id
`

export async function storeInboundEventOnly(
  run: QueryRunner,
  input: { phoneNumberId: string; providerEventKey: string; rawPayload: unknown },
): Promise<{ accountFound: boolean; duplicate: boolean; eventId: string | null }> {
  const rows = await run(INBOUND_EVENT_ONLY_SQL, [
    input.phoneNumberId,
    input.providerEventKey,
    JSON.stringify(input.rawPayload),
  ])
  const row = rows[0]
  const accountFound = row?.account_id != null
  return {
    accountFound,
    duplicate: accountFound && row?.event_id == null,
    eventId: (row?.event_id as string) ?? null,
  }
}

/**
 * Applying a delivery receipt to the message it belongs to.
 *
 * Provider acceptance, delivery and reading are distinct states, and the
 * receipts arrive out of order often enough that it matters: a `delivered`
 * webhook can land after `read`. So the update only ever moves a message
 * forward, never back. Without that rank check, an out-of-order `sent`
 * receipt would quietly undo a `read`.
 *
 * `failed` is the exception — it is terminal information and always wins,
 * because a message Meta could not deliver is not delivered no matter what
 * earlier receipt said.
 */
const APPLY_STATUS_SQL = `
with rank as (
  select
    case $2
      when 'sent' then 3 when 'delivered' then 4 when 'read' then 5
      else 0
    end as incoming
),
target as (
  select m.id, m.delivery_state,
         case m.delivery_state::text
           when 'pending' then 0 when 'dispatching' then 1 when 'accepted' then 2
           when 'sent' then 3 when 'delivered' then 4 when 'read' then 5
           else 0
         end as current
  from messages m
  join whatsapp_accounts a on a.operator_id = m.operator_id
  where m.provider_id = $1 and a.phone_number_id = $3
)
update messages m
set delivery_state = $2::delivery_state,
    error_code = case when $2 = 'failed' then coalesce($4, 'provider_failed') else m.error_code end
from target t, rank r
where m.id = t.id
  and ($2 = 'failed' or r.incoming > t.current)
returning m.id, m.delivery_state
`

export async function applyMessageStatus(
  run: QueryRunner,
  input: {
    providerMessageId: string
    status: string
    phoneNumberId: string
    errorCode?: string | null
  },
): Promise<{ applied: boolean; deliveryState: string | null }> {
  // Only states our enum knows. An unrecognised status is stored as an event
  // and otherwise ignored rather than crashing the intake.
  if (!['sent', 'delivered', 'read', 'failed'].includes(input.status)) {
    return { applied: false, deliveryState: null }
  }

  const rows = await run(APPLY_STATUS_SQL, [
    input.providerMessageId,
    input.status,
    input.phoneNumberId,
    input.errorCode ?? null,
  ])
  const row = rows[0]
  return {
    applied: row !== undefined,
    deliveryState: (row?.['delivery_state'] as string) ?? null,
  }
}
