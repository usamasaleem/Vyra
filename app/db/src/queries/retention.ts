import type { QueryRunner } from '../runner.js'

/**
 * Actually deleting what the operator said to delete.
 *
 * `retention_days` sits on the settings page under "Keeping records", with the
 * words "Conversations, contacts and anything a customer sent. Shorter is
 * kinder and harder to undo." It is validated between 30 and 3650, stored,
 * and written to the audit trail when it changes. Nothing has ever deleted a
 * row. An operator setting it to ninety days believed their customers' messages
 * were gone after ninety days, and they were all still there.
 *
 * That is a worse class of bug than a missing button. A missing button is
 * visible the moment somebody looks for it; this one looks exactly like
 * working software from every angle available to the person relying on it.
 *
 * What it deletes is what the sentence promises: the conversation, its
 * messages, the notes on it, what the customer told us, and the contact once
 * nothing else refers to them.
 *
 * What it does not touch is a conversation that became business. A quote is
 * the operator's record of a price they offered and a booking is a record of a
 * car they committed; in this market those are kept for years and no setting
 * on a sales screen should quietly bin them. So a conversation carrying either
 * is skipped, permanently, and the page says so. Everything else — the
 * enquiries that went nowhere, which is most of them — goes on schedule.
 *
 * Nothing here is recoverable, so it is deliberately narrow, batched, and
 * counts what it did.
 */
export type PurgeResult = {
  conversations: number
  messages: number
  contacts: number
}

/**
 * The cutoff is per operator and measured from the last thing that happened,
 * not from when the conversation opened. A thread that ran for eight months is
 * eight months old on its last message, not on its first.
 */
const EXPIRED = `
  select v.id, v.contact_id
  from conversations v
  join operators o on o.id = v.operator_id
  left join lateral (
    select max(created_at) as at from messages m
    where m.conversation_id = v.id and m.operator_id = v.operator_id
  ) last_message on true
  where coalesce(last_message.at, v.created_at)
        < now() - make_interval(days => o.retention_days)
    -- A conversation that became business is a record of a transaction, and a
    -- setting on a sales screen does not get to bin one.
    and not exists (select 1 from quotes q where q.conversation_id = v.id)
    and not exists (select 1 from bookings b where b.conversation_id = v.id)
  limit $1
`

export async function purgeExpiredConversations(
  run: QueryRunner,
  options: { limit?: number } = {},
): Promise<PurgeResult> {
  const doomed = await run(EXPIRED, [options.limit ?? 200])
  if (doomed.length === 0) return { conversations: 0, messages: 0, contacts: 0 }

  const ids = doomed.map((r) => r['id'] as string)

  /**
   * Explicit, in dependency order, because every foreign key here is NO
   * ACTION. A cascade would be shorter and would also mean nobody had decided
   * which of these tables ought to go — which is the whole question.
   */
  const [counted] = await run(
    `select count(*)::int as n from messages where conversation_id = any($1::uuid[])`, [ids],
  )

  await run(
    `delete from field_evidence where enquiry_id in (
       select id from enquiries where conversation_id = any($1::uuid[]))`, [ids],
  )
  for (const table of [
    'agent_runs', 'messages', 'conversation_notes', 'follow_ups',
    'handoffs', 'operations_requests', 'enquiries',
  ]) {
    await run(`delete from ${table} where conversation_id = any($1::uuid[])`, [ids])
  }
  await run(`delete from conversations where id = any($1::uuid[])`, [ids])

  /**
   * And the person, once nothing refers to them. A phone number outliving
   * every conversation it belonged to is the part of this that is personal
   * data rather than business record.
   */
  const contacts = await run(
    `delete from contacts c
     where c.id = any($1::uuid[])
       and not exists (select 1 from conversations v where v.contact_id = c.id)
     returning c.id`,
    [doomed.map((r) => r['contact_id'] as string)],
  )

  return {
    conversations: ids.length,
    messages: Number(counted?.['n'] ?? 0),
    contacts: contacts.length,
  }
}

/**
 * What would go, without going.
 *
 * On the settings page beside the number, because "shorter is kinder and
 * harder to undo" is a sentence somebody should be able to check before they
 * find out whether it was true.
 */
export async function countExpiredConversations(
  run: QueryRunner,
  operatorId: string,
): Promise<{ expired: number; keptAsRecords: number }> {
  const [row] = await run(
    `select
       (select count(*)::int from conversations v
        join operators o on o.id = v.operator_id
        left join lateral (
          select max(created_at) as at from messages m
          where m.conversation_id = v.id and m.operator_id = v.operator_id
        ) last_message on true
        where v.operator_id = $1
          and coalesce(last_message.at, v.created_at)
              < now() - make_interval(days => o.retention_days)
          and not exists (select 1 from quotes q where q.conversation_id = v.id)
          and not exists (select 1 from bookings b where b.conversation_id = v.id)
       ) as expired,
       (select count(*)::int from conversations v
        join operators o on o.id = v.operator_id
        left join lateral (
          select max(created_at) as at from messages m
          where m.conversation_id = v.id and m.operator_id = v.operator_id
        ) last_message on true
        where v.operator_id = $1
          and coalesce(last_message.at, v.created_at)
              < now() - make_interval(days => o.retention_days)
          and (exists (select 1 from quotes q where q.conversation_id = v.id)
            or exists (select 1 from bookings b where b.conversation_id = v.id))
       ) as kept_as_records`,
    [operatorId],
  )
  return {
    expired: Number(row?.['expired'] ?? 0),
    keptAsRecords: Number(row?.['kept_as_records'] ?? 0),
  }
}
