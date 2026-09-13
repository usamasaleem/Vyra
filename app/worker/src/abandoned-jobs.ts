import type { QueryRunner } from './relay.js'

/**
 * Releasing jobs abandoned by a worker that died without shutting down.
 *
 * graphile-worker already does this, but its staleness threshold is four hours
 * and it is hard-coded in the migration SQL rather than exposed as an option —
 * `minResetLockedInterval` only changes how often the sweep runs, not what it
 * considers stale. Four hours is a reasonable default for a queue of
 * background work. It is not reasonable here, because jobs are serialised per
 * conversation: one abandoned lock stops every later message from that
 * customer, and the symptom is silence.
 *
 * Clean shutdown handles the ordinary case — a deploy — and is verified. This
 * covers the rest: an out-of-memory kill, a host restart, a pulled plug.
 *
 * The threshold is deliberately far longer than any job takes. Dispatch takes
 * two or three seconds; an AI turn will take tens. Ten minutes is long enough
 * that releasing a job which is genuinely still running is implausible, and
 * short enough that a customer is not left waiting through the afternoon.
 *
 * Releasing a lock does not lose work: the job returns to the queue and is
 * retried, and the dispatcher's own claim (pending -> dispatching) is what
 * stops a retry from sending a message twice.
 */
const ABANDONED_AFTER_SECONDS = 600

/**
 * Written against graphile-worker's private tables, because the public `jobs`
 * view is not updatable. `_private_jobs` stores a task id rather than the
 * identifier, so the name is joined back for the log line — a task identifier
 * is what a person reading it needs, not a foreign key.
 *
 * This reaches into another library's internals, which is a real cost: a
 * future version could rename these. The alternative is a customer waiting
 * four hours, so it is the right trade — but it belongs in one small file that
 * says so, rather than spread through the worker.
 */
const RELEASE_SQL = `
  with released as (
    update graphile_worker._private_jobs
    set locked_at = null, locked_by = null
    where locked_at is not null
      and locked_at < now() - make_interval(secs => $1)
    returning id, task_id
  )
  select r.id, coalesce(t.identifier, 'unknown') as task_identifier
  from released r
  left join graphile_worker._private_tasks t on t.id = r.task_id
`

export async function releaseAbandonedJobs(
  run: QueryRunner,
  options: { abandonedAfterSeconds?: number } = {},
): Promise<{ released: number; tasks: string[] }> {
  const rows = await run(RELEASE_SQL, [options.abandonedAfterSeconds ?? ABANDONED_AFTER_SECONDS])
  return {
    released: rows.length,
    tasks: [...new Set(rows.map((r) => String(r['task_identifier'])))],
  }
}
