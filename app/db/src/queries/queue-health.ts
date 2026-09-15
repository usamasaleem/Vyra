import type { QueryRunner } from '../runner.js'

/**
 * How long customers wait before anything starts, and what is stuck right now.
 *
 * Every other measure in this system records work that happened: the outbox
 * records publishing, agent_runs records the turn. Between them sat a gap
 * nobody measured, and on 15 September a customer sat in it for ninety-six
 * seconds. Publishing took 0.8s and the turn took 4s, so both halves looked
 * healthy; the minute and a half in the middle existed in no table. It was
 * found because the customer sent the message a second time.
 *
 * Completed jobs are deleted by graphile-worker, so a delay that has ended
 * leaves no trace at all unless something wrote it down while it was
 * happening. That is what queue_wait_ms on agent_runs is for, and what the
 * backlog query below catches while it is still going on.
 */

/**
 * Work that is late right now.
 *
 * Read against the private tables for the same reason as the abandoned-job
 * sweep: the public `jobs` view hides the queue locks, and a locked queue is
 * half of what causes this. Both halves matter and they fail differently —
 *
 *   waiting: the job is due, nothing holds it, and no worker has picked it up.
 *            Either no worker is running, or every worker is busy.
 *   locked:  a worker claimed it and has not finished. Past a minute or two
 *            that usually means the worker died holding it, and because jobs
 *            are serialised per conversation, it is blocking every later
 *            message from that one customer.
 *
 * The second is the dangerous one. It is silent, it affects exactly one
 * customer, and the abandoned-job sweep only releases it after ten minutes.
 */
export type QueueBacklogEntry = {
  jobId: string
  task: string
  /** The conversation this serialises against, when the job names one. */
  queueName: string | null
  state: 'waiting' | 'locked'
  /** Seconds late: past its run_at if waiting, held for this long if locked. */
  lateSeconds: number
  attempts: number
  lastError: string | null
}

const BACKLOG_SQL = `
  select
    j.id::text                                        as job_id,
    coalesce(t.identifier, 'unknown')                 as task,
    j.job_queue_id                                    as queue_id,
    q.queue_name                                      as queue_name,
    case when j.locked_at is null then 'waiting' else 'locked' end as state,
    extract(epoch from (now() - coalesce(j.locked_at, j.run_at)))::int as late_seconds,
    j.attempts                                        as attempts,
    j.last_error                                      as last_error
  from graphile_worker._private_jobs j
  left join graphile_worker._private_tasks t       on t.id = j.task_id
  left join graphile_worker._private_job_queues q  on q.id = j.job_queue_id
  where coalesce(j.locked_at, j.run_at) < now() - make_interval(secs => $1)
  order by coalesce(j.locked_at, j.run_at)
  limit 50
`

/**
 * Not scoped by operator, and deliberately so.
 *
 * The queue is infrastructure shared by every operator, and the failure this
 * finds — a worker holding a lock — is not a fact about anyone's sales. Scoping
 * it would mean joining through the payload to a conversation, which is exactly
 * the work that is currently stuck.
 */
export async function findQueueBacklog(
  run: QueryRunner,
  options: { lateAfterSeconds?: number } = {},
): Promise<QueueBacklogEntry[]> {
  const rows = await run(BACKLOG_SQL, [options.lateAfterSeconds ?? 15])
  return rows.map((r) => ({
    jobId: String(r['job_id']),
    task: String(r['task']),
    queueName: r['queue_name'] === null ? null : String(r['queue_name']),
    state: r['state'] === 'locked' ? 'locked' : 'waiting',
    lateSeconds: Number(r['late_seconds'] ?? 0),
    attempts: Number(r['attempts'] ?? 0),
    lastError: r['last_error'] === null ? null : String(r['last_error']),
  }))
}

/**
 * What the waits have looked like over a window, from the runs that finished.
 *
 * The median is the honest headline and the maximum is the one worth acting
 * on: a median of 300ms with a maximum of ninety-six seconds is precisely the
 * shape of the failure this was built for, and an average would have hidden it
 * completely.
 */
export type QueueWaitSummary = {
  /** Runs in the window that recorded a wait. Older runs recorded none. */
  measured: number
  medianMs: number | null
  p95Ms: number | null
  maxMs: number | null
  /** Runs that waited longer than the threshold. Each one is a customer. */
  slow: number
  slowerThanMs: number
}

const WAITS_SQL = `
  select
    count(queue_wait_ms)::int                                                as measured,
    percentile_disc(0.5)  within group (order by queue_wait_ms)::int         as median_ms,
    percentile_disc(0.95) within group (order by queue_wait_ms)::int         as p95_ms,
    max(queue_wait_ms)::int                                                  as max_ms,
    count(*) filter (where queue_wait_ms > $3)::int                          as slow
  from agent_runs
  where operator_id = $1 and created_at >= $2
`

export async function getQueueWaits(
  run: QueryRunner,
  operatorId: string,
  since: Date,
  options: { slowerThanMs?: number } = {},
): Promise<QueueWaitSummary> {
  const slowerThanMs = options.slowerThanMs ?? 15_000
  const [row] = await run(WAITS_SQL, [operatorId, since.toISOString(), slowerThanMs])
  const measured = Number(row?.['measured'] ?? 0)

  // Null rather than zero when nothing recorded a wait: every run from before
  // this column existed has a null, and reporting those as instant would be a
  // lie told by the very thing built to stop one.
  const ms = (key: string) =>
    measured === 0 || row?.[key] === null || row?.[key] === undefined ? null : Number(row[key])

  return {
    measured,
    medianMs: ms('median_ms'),
    p95Ms: ms('p95_ms'),
    maxMs: ms('max_ms'),
    slow: Number(row?.['slow'] ?? 0),
    slowerThanMs,
  }
}
