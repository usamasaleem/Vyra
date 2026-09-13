import type { QueryRunner } from './relay.js'

/**
 * Build plan step 12 — failures a person can see and act on.
 *
 * Backoff and dead-lettering already exist in the relay and the dispatcher.
 * What was missing is the other half of the requirement: terminal failures
 * have to land somewhere a human can find them. A failure nobody can see is
 * indistinguishable from a message that never arrived.
 *
 * These queries are the data behind the inbox's failure view in phase 3. The
 * CLI in `cli/failures.ts` is the interim surface.
 */

export type StuckKind =
  | 'dead_outbox'
  | 'failed_send'
  | 'ambiguous_send'
  | 'failed_inbound_event'

export type StuckItem = {
  kind: StuckKind
  id: string
  operatorId: string
  detail: string
  occurredAt: Date
  /** False when retrying could duplicate a real customer message. */
  safeToRetry: boolean
}

const LIST_SQL = `
  select 'dead_outbox' as kind, o.id::text as id, o.operator_id::text as operator_id,
         coalesce(o.event_type || ': ' || coalesce(o.last_error, 'no error recorded'), 'unknown') as detail,
         o.created_at as occurred_at, true as safe_to_retry
  from outbox o
  where o.status = 'dead'

  union all

  select 'failed_send', m.id::text, m.operator_id::text,
         'send failed (' || coalesce(m.error_code, '?') || '): ' || coalesce(m.error_detail, ''),
         m.created_at, true
  from messages m
  where m.direction = 'outbound' and m.delivery_state = 'failed'

  union all

  /**
   * Meta may have delivered these. Retrying duplicates a real customer
   * message; calling them failed loses one. A person decides.
   */
  select 'ambiguous_send', m.id::text, m.operator_id::text,
         'outcome unknown: ' || coalesce(m.error_detail, 'no response from Meta'),
         m.created_at, false
  from messages m
  where m.direction = 'outbound' and m.delivery_state = 'unknown'

  union all

  select 'failed_inbound_event', e.id::text, e.operator_id::text,
         coalesce(e.last_error, 'processing failed'), e.received_at, true
  from inbound_events e
  where e.status = 'failed'

  order by occurred_at desc
  limit $1
`

export async function listStuckWork(
  run: QueryRunner,
  options: { limit?: number } = {},
): Promise<StuckItem[]> {
  const rows = await run(LIST_SQL, [options.limit ?? 100])
  return rows.map((r) => ({
    kind: r['kind'] as StuckKind,
    id: r['id'] as string,
    operatorId: r['operator_id'] as string,
    detail: r['detail'] as string,
    occurredAt: new Date(r['occurred_at'] as string),
    safeToRetry: r['safe_to_retry'] === true,
  }))
}

/**
 * A worker that dies between claiming a row and hearing back from Meta leaves
 * it in `dispatching` forever.
 *
 * We cannot tell whether it crashed before the request left or after Meta
 * accepted it, so the honest state is `unknown`, not `pending`. Putting it
 * back to pending would be a guess that risks sending a customer the same
 * message twice — precisely the resolution section 18.10 forbids.
 */
export async function reapStaleDispatching(
  run: QueryRunner,
  options: { olderThanSeconds?: number } = {},
): Promise<{ reaped: number }> {
  const rows = await run(
    `update messages
       set delivery_state = 'unknown',
           error_code = 'dispatch_interrupted',
           error_detail = 'worker stopped mid-dispatch; Meta may or may not have accepted this'
     where direction = 'outbound'
       and delivery_state = 'dispatching'
       and created_at < now() - make_interval(secs => $1)
     returning id`,
    [options.olderThanSeconds ?? 300],
  )
  return { reaped: rows.length }
}

export type RetryResult =
  | { retried: true }
  | { retried: false; reason: 'not_found' | 'not_retryable' | 'refused_ambiguous' }

/** Puts a dead outbox row back in the queue for another attempt. */
export async function retryOutboxRow(run: QueryRunner, id: string): Promise<RetryResult> {
  const rows = await run(
    `update outbox
       set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
     where id = $1 and status = 'dead'
     returning id`,
    [id],
  )
  return rows.length > 0 ? { retried: true } : { retried: false, reason: 'not_found' }
}

/**
 * Re-queues a failed send.
 *
 * Deliberately refuses a message whose outcome is unknown. Section 18.10 says
 * that case needs an explicit operator-approved policy, not a retry button
 * that happens to be next to the others.
 */
export async function retryFailedSend(run: QueryRunner, id: string): Promise<RetryResult> {
  const found = await run(
    `select delivery_state from messages where id = $1 and direction = 'outbound'`,
    [id],
  )
  const state = found[0]?.['delivery_state']
  if (state === undefined) return { retried: false, reason: 'not_found' }
  if (state === 'unknown') return { retried: false, reason: 'refused_ambiguous' }
  if (state !== 'failed') return { retried: false, reason: 'not_retryable' }

  await run(
    `update messages set delivery_state = 'pending', error_code = null, error_detail = null where id = $1`,
    [id],
  )
  await run(
    `insert into outbox (operator_id, event_type, aggregate_id, payload)
     select operator_id, 'dispatch_outbound', id,
            jsonb_build_object('message_id', id, 'conversation_id', conversation_id)
     from messages where id = $1`,
    [id],
  )
  return { retried: true }
}
