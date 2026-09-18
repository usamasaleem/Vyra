import type { QueryRunner } from './relay.js'

/**
 * Releasing work abandoned by a worker that died without shutting down.
 *
 * graphile-worker does this itself, but its staleness threshold is four hours,
 * hard-coded in the migration SQL rather than exposed as an option —
 * `minResetLockedInterval` changes how often the sweep runs, not what counts
 * as stale. Four hours is a fair default for background work. It is not fair
 * here, because jobs are serialised per conversation: one abandoned lock stops
 * every later message from that customer, and the symptom is silence.
 *
 * Clean shutdown handles the ordinary case — a deploy — and is verified. This
 * covers the rest: an out-of-memory kill, a host restart, a pulled plug.
 */

/**
 * Deliberately far longer than any job takes. Dispatch is two or three
 * seconds; an AI turn will be tens. Ten minutes makes releasing something
 * genuinely running implausible, while not leaving a customer waiting through
 * the afternoon.
 *
 * Releasing a lock does not lose work: the job returns to the queue and is
 * retried, and the dispatcher's own pending-to-dispatching claim is what stops
 * a retry from sending the same message twice.
 */
const ABANDONED_AFTER_SECONDS = 600

/**
 * A send has no business holding a lock for ten minutes.
 *
 * The number above is sized for the slowest thing that can legitimately be
 * running: an inbound turn is up to four model rounds at a sixty-second
 * timeout each, plus thirty for a voice note, so roughly four and a half
 * minutes in the worst case even though the slowest of a hundred and fifty
 * real turns took twenty-one seconds. Releasing one of those early would mean
 * a second worker picking it up while the first is still thinking, and the
 * customer getting the same answer twice.
 *
 * Dispatch has no such ceiling to respect. It is one HTTP call to Meta, two or
 * three seconds, and nothing about it can take minutes. Making it wait the
 * same ten minutes means a conversation sits silent for ten minutes after a
 * deploy lands mid-send — and because jobs are serialised per conversation,
 * every later message from that customer waits behind it.
 */
const ABANDONED_SEND_AFTER_SECONDS = 90

/**
 * Both the job AND its queue have to be released.
 *
 * Serialisation works by locking the queue row, so a worker that dies holding
 * a job leaves two locks behind, and freeing only the job achieves nothing —
 * the queue still refuses to hand anything out. Found the hard way: after
 * releasing the jobs, a worker sat beside three available jobs and processed
 * none of them.
 *
 * Written against private tables because the public `jobs` view is not
 * updatable. That is a real cost — a future version could rename these — and
 * it is confined to this one file, which says so.
 */
const RELEASE_SQL = `
  with released_jobs as (
    update graphile_worker._private_jobs j
    set locked_at = null, locked_by = null
    where j.locked_at is not null
      and j.locked_at < now() - make_interval(
            -- Per task, because the ceiling each one has to respect is its own.
            --
            -- Cast explicitly. Used directly, a parameter here infers double
            -- precision from make_interval's own signature; inside a CASE it
            -- infers from the branches instead, lands on text, and the whole
            -- sweep fails with "function make_interval(secs => text) does not
            -- exist" — which is silent, because the sweep's errors are logged
            -- and swallowed so one bad statement cannot stop the worker.
            secs => case
              when (select t.identifier from graphile_worker._private_tasks t
                    where t.id = j.task_id) = 'dispatch_outbound'
              then $2::float else $1::float
            end)
    returning id, task_id
  ),
  released_queues as (
    -- is_available is a generated column derived from locked_at: setting it
    -- explicitly is rejected, and clearing the lock updates it anyway.
    update graphile_worker._private_job_queues
    set locked_at = null, locked_by = null
    where locked_at is not null
      -- The queue lock uses the longer of the two: a queue held by a turn that
      -- is still legitimately running must not be handed out underneath it.
      and locked_at < now() - make_interval(secs => $1::float)
    returning id
  )
  select
    (select count(*)::int from released_jobs)    as jobs_released,
    (select count(*)::int from released_queues)  as queues_released,
    coalesce(
      (select array_agg(distinct coalesce(t.identifier, 'unknown'))
       from released_jobs j
       left join graphile_worker._private_tasks t on t.id = j.task_id),
      '{}'
    ) as tasks
`

export type ReleaseResult = {
  released: number
  queuesReleased: number
  tasks: string[]
}

export async function releaseAbandonedJobs(
  run: QueryRunner,
  options: { abandonedAfterSeconds?: number; sendAbandonedAfterSeconds?: number } = {},
): Promise<ReleaseResult> {
  const rows = await run(RELEASE_SQL, [
    options.abandonedAfterSeconds ?? ABANDONED_AFTER_SECONDS,
    options.sendAbandonedAfterSeconds ?? ABANDONED_SEND_AFTER_SECONDS,
  ])
  const row = rows[0]
  return {
    released: Number(row?.['jobs_released'] ?? 0),
    queuesReleased: Number(row?.['queues_released'] ?? 0),
    tasks: (row?.['tasks'] as string[]) ?? [],
  }
}
