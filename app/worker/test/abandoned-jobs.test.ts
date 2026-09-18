import { describe, expect, it, vi } from 'vitest'
import { releaseAbandonedJobs } from '../src/abandoned-jobs.ts'
import type { QueryRunner } from '../src/relay.ts'

/**
 * graphile-worker's own tables are not created by our migrations, so these
 * check the statement's shape and behaviour against a recording runner rather
 * than a live schema. The statement itself is exercised against the real
 * database when the worker runs.
 */
describe('releasing abandoned jobs', () => {
  it('reports nothing when no lock is stale', async () => {
    const run: QueryRunner = vi.fn(async () => [{ jobs_released: 0, queues_released: 0, tasks: [] }])
    expect(await releaseAbandonedJobs(run)).toEqual({ released: 0, queuesReleased: 0, tasks: [] })
  })

  it('reports jobs and queues separately', async () => {
    const run: QueryRunner = vi.fn(async () => [
      { jobs_released: 3, queues_released: 2, tasks: ['dispatch_outbound', 'process_inbound_message'] },
    ])
    expect(await releaseAbandonedJobs(run)).toEqual({
      released: 3,
      queuesReleased: 2,
      tasks: ['dispatch_outbound', 'process_inbound_message'],
    })
  })

  /**
   * The bug this file exists to prevent recurring: releasing only the jobs
   * leaves the queue locked, and the queue is what actually blocks.
   */
  it('releases the job queues as well as the jobs', async () => {
    const calls: string[] = []
    const run: QueryRunner = async (text) => { calls.push(text); return [] }
    await releaseAbandonedJobs(run)
    expect(calls[0]).toMatch(/_private_jobs/)
    expect(calls[0]).toMatch(/_private_job_queues/)
  })

  it('only touches rows that are actually locked', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const run: QueryRunner = async (text, params) => { calls.push({ text, params }); return [] }
    await releaseAbandonedJobs(run)

    expect(calls[0]!.text).toMatch(/locked_at is not null/)
    expect(calls[0]!.text).toMatch(/set locked_at = null, locked_by = null/)
  })

  /**
   * The threshold must stay far above how long a job takes. Dispatch is
   * seconds; an AI turn will be tens of seconds. Releasing a job that is
   * genuinely running would risk a duplicate send.
   */
  it('defaults to a threshold far longer than any job takes', async () => {
    const calls: unknown[][] = []
    const run: QueryRunner = async (_t, p) => { calls.push(p as unknown[]); return [] }
    await releaseAbandonedJobs(run)
    expect(calls[0]![0]).toBeGreaterThanOrEqual(300)
  })

  it('accepts a shorter threshold when asked', async () => {
    const calls: unknown[][] = []
    const run: QueryRunner = async (_t, p) => { calls.push(p as unknown[]); return [] }
    await releaseAbandonedJobs(run, { abandonedAfterSeconds: 60 })
    expect(calls[0]![0]).toBe(60)
  })
})

/**
 * A send stuck behind a deploy, and a turn that may legitimately be slow.
 *
 * Read live: a deploy landed while a turn was running, the worker was killed
 * before it could finish, and the lock sat there. Jobs are serialised per
 * conversation, so the customer's next message waited behind it — and the
 * symptom, as always, was silence.
 *
 * The ten-minute threshold is sized for the slowest thing that can honestly
 * still be running: four model rounds at a sixty-second timeout, plus thirty
 * for a voice note. A send has no such ceiling to respect.
 */
describe('how long each kind of work is given', () => {
  const capture = async () => {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const run: QueryRunner = async (text, params) => { calls.push({ text, params: params ?? [] }); return [] }
    await releaseAbandonedJobs(run)
    return calls[0]!
  }

  it('gives a send far less rope than a turn', async () => {
    const { params } = await capture()
    const [turnSeconds, sendSeconds] = params as number[]
    expect(sendSeconds).toBeLessThan(turnSeconds as number)
    expect(sendSeconds).toBe(90)
    expect(turnSeconds).toBe(600)
  })

  /** Both timings are the caller's to override, which is what the tests need. */
  it('lets both be set', async () => {
    const calls: Array<unknown[]> = []
    const run: QueryRunner = async (_t, params) => { calls.push(params ?? []); return [] }
    await releaseAbandonedJobs(run, { abandonedAfterSeconds: 30, sendAbandonedAfterSeconds: 5 })
    expect(calls[0]).toEqual([30, 5])
  })

  it('picks the threshold from the task rather than applying one to all', async () => {
    const { text } = await capture()
    expect(text).toMatch(/dispatch_outbound/)
    expect(text).toMatch(/_private_tasks/)
  })

  /**
   * The queue lock keeps the longer one on purpose: handing a queue out from
   * under a turn that is still thinking is how a customer gets two answers.
   */
  it('never frees a queue on the shorter timing', async () => {
    const { text } = await capture()
    const queuePart = text.slice(text.indexOf('_private_job_queues'))
    expect(queuePart).not.toMatch(/\$2/)
  })
})

/**
 * The sweep's own errors are logged and swallowed, so that one bad statement
 * cannot stop the worker. That is right, and it means a broken statement here
 * is invisible: it fails every ten seconds into a log nobody reads while jobs
 * sit locked. It happened the moment the CASE above was added — a parameter
 * used directly infers double precision from make_interval's signature, and
 * inside a CASE infers from the branches instead, landing on text.
 */
describe('the statement itself', () => {
  it('casts both timings, because a CASE cannot infer them', async () => {
    const calls: string[] = []
    const run: QueryRunner = async (text) => { calls.push(text); return [] }
    await releaseAbandonedJobs(run)

    const sql = calls[0]!
    // Both timings are cast where they are used as seconds...
    expect(sql).toMatch(/\$1::float/)
    expect(sql).toMatch(/\$2::float/)
    // ...and neither is ever handed to make_interval bare.
    expect(sql).not.toMatch(/secs => \$\d(?!::)/)
    expect(sql).not.toMatch(/then \$\d(?!::)/)
  })
})
