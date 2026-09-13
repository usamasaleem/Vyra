/**
 * Build plan step 9 — the outbox relay.
 *
 * Step 8 writes an outbox row inside the same statement that stores the
 * message, so work owed is durable the moment the webhook acknowledges. This
 * turns those rows into queued jobs.
 *
 * Because the queue lives in the same PostgreSQL instance as the outbox, the
 * claim, the enqueue and the mark-as-published all happen in ONE transaction.
 * That is stronger than the specification requires: section 18.4 only asks
 * that publishing twice be harmless, because it assumes a separate broker
 * where atomicity is impossible. Here it is possible, so we take it — and the
 * job key keeps a double publish harmless anyway, if the process dies between
 * commit and acknowledgement.
 */

export type { QueryRunner, Transactor } from '@vyra/db'
import type { QueryRunner, Transactor } from '@vyra/db'

export type OutboxRow = {
  id: string
  operator_id: string
  event_type: string
  aggregate_id: string | null
  payload: Record<string, unknown>
  attempts: number
}

/** Enqueues one claimed row. Runs inside the claiming transaction. */
export type Publisher = (tx: QueryRunner, row: OutboxRow) => Promise<void>

export type RelayResult = {
  claimed: number
  published: number
  deferred: number
  dead: number
}

/**
 * Terminal after this many attempts. The row stays visible as `dead` so a
 * person can see and retry it, which is step 12's requirement: a failure that
 * nobody can see is indistinguishable from a message that never arrived.
 */
const MAX_ATTEMPTS = 10

const CLAIM_SQL = `
  select id, operator_id, event_type, aggregate_id, payload, attempts
  from outbox
  where status = 'pending' and next_attempt_at <= now()
  order by created_at
  for update skip locked
  limit $1
`

/**
 * FOR UPDATE SKIP LOCKED is what makes this safe to run in several processes
 * at once: each claims a disjoint set and none of them wait on the others.
 */
export async function relayOnce(
  transact: Transactor,
  publish: Publisher,
  options: { batchSize?: number } = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 20
  const result: RelayResult = { claimed: 0, published: 0, deferred: 0, dead: 0 }

  const rows = await transact(async (tx) => {
    const claimed = (await tx(CLAIM_SQL, [batchSize])) as unknown as OutboxRow[]
    return claimed
  })
  result.claimed = rows.length
  if (rows.length === 0) return result

  // One transaction per row. A poisonous payload that aborts its transaction
  // must not roll back the jobs published alongside it in the same batch.
  for (const row of rows) {
    try {
      await transact(async (tx) => {
        // Re-claim inside this transaction; another relay may have taken it
        // between the batch claim and now.
        const held = await tx(
          `select id from outbox where id = $1 and status = 'pending' for update skip locked`,
          [row.id],
        )
        if (held.length === 0) return

        await publish(tx, row)
        await tx(
          `update outbox set status = 'published', published_at = now(), attempts = attempts + 1
           where id = $1`,
          [row.id],
        )
      })
      result.published += 1
    } catch (error) {
      const attempts = row.attempts + 1
      const dead = attempts >= MAX_ATTEMPTS
      if (dead) result.dead += 1
      else result.deferred += 1

      // Bounded exponential backoff with jitter, per section 18.10. The jitter
      // matters when a shared dependency recovers: without it every deferred
      // row retries in the same instant and knocks it over again.
      const backoffSeconds = Math.min(2 ** attempts, 300) * (0.5 + Math.random())
      await transact(async (tx) => {
        await tx(
          `update outbox
             set status = $2, attempts = $3, last_error = $4,
                 next_attempt_at = now() + make_interval(secs => $5)
           where id = $1`,
          [
            row.id,
            dead ? 'dead' : 'pending',
            attempts,
            error instanceof Error ? error.message : String(error),
            backoffSeconds,
          ],
        )
      })
    }
  }

  return result
}

/**
 * The production publisher: hand the job to graphile-worker.
 *
 * `queue_name` is the conversation id, which serialises every job for one
 * conversation. Section 18.10 is explicit that a global concurrency setting
 * does not do this — two rapid messages from one customer processed in
 * parallel produce interleaved replies and conflicting state.
 *
 * `job_key` is the outbox row id, so publishing the same row twice replaces
 * one job rather than creating two.
 */
export const publishToGraphileWorker: Publisher = async (tx, row) => {
  const conversationId = row.payload['conversation_id']
  await tx(
    `select graphile_worker.add_job(
       identifier => $1,
       payload    => $2::json,
       queue_name => $3,
       job_key    => $4,
       max_attempts => 5
     )`,
    [
      row.event_type,
      JSON.stringify({ ...row.payload, operator_id: row.operator_id, outbox_id: row.id }),
      typeof conversationId === 'string' ? `conversation:${conversationId}` : null,
      `outbox:${row.id}`,
    ],
  )
}
