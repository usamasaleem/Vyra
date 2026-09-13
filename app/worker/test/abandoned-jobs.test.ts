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
