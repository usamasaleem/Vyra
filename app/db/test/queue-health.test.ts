import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { findQueueBacklog, getQueueWaits } from '../src/queries/queue-health.ts'
import { recordAgentRun } from '../src/queries/agent-runs.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

/**
 * graphile-worker's own tables are created by its migrations, which do not run
 * here. The shape below is only the columns this query reads, and that is the
 * honest limit of this test: it proves the SQL and the mapping, not that the
 * real tables look like this. The thing that proves the latter is the live
 * query, and the abandoned-job sweep already reads the same two tables.
 */
const GRAPHILE_SHAPE = `
  create schema graphile_worker;
  create table graphile_worker._private_tasks (id int primary key, identifier text not null);
  create table graphile_worker._private_job_queues (id int primary key, queue_name text not null);
  create table graphile_worker._private_jobs (
    id bigint primary key,
    task_id int,
    job_queue_id int,
    run_at timestamptz not null,
    locked_at timestamptz,
    attempts int not null default 0,
    last_error text
  );
  insert into graphile_worker._private_tasks values (1, 'process_inbound_message'), (2, 'dispatch_outbound');
  insert into graphile_worker._private_job_queues values (1, 'conversation:66666666'), (2, 'conversation:77777777');
`

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  await db.exec(GRAPHILE_SHAPE)
})

const job = (
  id: number,
  opts: { taskId?: number; queueId?: number; dueSecondsAgo?: number; lockedSecondsAgo?: number; attempts?: number; lastError?: string },
) =>
  db.exec(`
    insert into graphile_worker._private_jobs (id, task_id, job_queue_id, run_at, locked_at, attempts, last_error)
    values (
      ${id},
      ${opts.taskId ?? 1},
      ${opts.queueId ?? 1},
      now() - interval '${opts.dueSecondsAgo ?? 0} seconds',
      ${opts.lockedSecondsAgo === undefined ? 'null' : `now() - interval '${opts.lockedSecondsAgo} seconds'`},
      ${opts.attempts ?? 0},
      ${opts.lastError === undefined ? 'null' : `'${opts.lastError}'`}
    )
  `)

const wait = (queueWaitMs: number | null) =>
  recordAgentRun(run, {
    operatorId: OP, conversationId: CONV, messageId: null, inputRevision: 1,
    promptVersion: 'sales-v10', modelId: 'gpt-5.6-luna', resultState: 'queued',
    queueWaitMs, durationMs: 4000,
  })

describe('findQueueBacklog', () => {
  it('finds nothing when the queue is keeping up', async () => {
    await job(1, { dueSecondsAgo: 1 })
    expect(await findQueueBacklog(run)).toEqual([])
  })

  it('reports a job that is due and nobody has picked up', async () => {
    await job(1, { dueSecondsAgo: 40 })

    const [late] = await findQueueBacklog(run)
    expect(late).toMatchObject({
      task: 'process_inbound_message',
      queueName: 'conversation:66666666',
      state: 'waiting',
    })
    expect(late!.lateSeconds).toBeGreaterThanOrEqual(39)
  })

  /**
   * The failure that is silent. A worker died holding the lock, and because
   * jobs are serialised per conversation this is one customer hearing nothing
   * while everything else in the system looks healthy.
   */
  it('reports a job a worker has been holding, and says so', async () => {
    await job(2, { taskId: 2, dueSecondsAgo: 300, lockedSecondsAgo: 120, attempts: 1 })

    const [held] = await findQueueBacklog(run)
    expect(held).toMatchObject({ task: 'dispatch_outbound', state: 'locked', attempts: 1 })
    // Late by how long it has been held, not by how long ago it was due. A job
    // picked up promptly and then stuck is not five minutes late.
    expect(held!.lateSeconds).toBeGreaterThanOrEqual(119)
    expect(held!.lateSeconds).toBeLessThan(140)
  })

  it('carries the last error, so a retrying job explains itself', async () => {
    await job(3, { dueSecondsAgo: 60, attempts: 4, lastError: 'provider timeout' })
    expect((await findQueueBacklog(run))[0]).toMatchObject({
      attempts: 4, lastError: 'provider timeout',
    })
  })

  it('takes the threshold from the caller', async () => {
    await job(4, { dueSecondsAgo: 5 })
    expect(await findQueueBacklog(run)).toEqual([])
    expect(await findQueueBacklog(run, { lateAfterSeconds: 2 })).toHaveLength(1)
  })

  it('puts the longest wait first', async () => {
    await job(5, { dueSecondsAgo: 30 })
    await job(6, { dueSecondsAgo: 300 })
    expect((await findQueueBacklog(run)).map((j) => j.jobId)).toEqual(['6', '5'])
  })
})

describe('getQueueWaits', () => {
  const since = () => new Date(Date.now() - 86_400_000)

  it('says nothing was measured rather than reporting zero', async () => {
    await wait(null)
    const summary = await getQueueWaits(run, OP, since())
    expect(summary).toMatchObject({ measured: 0, medianMs: null, p95Ms: null, maxMs: null })
  })

  /**
   * The shape this was built for: a healthy median hiding one customer who
   * waited a minute and a half. An average would have reported nine seconds
   * and nobody would have looked.
   */
  it('reports the median and the maximum separately', async () => {
    for (let i = 0; i < 9; i++) await wait(300)
    await wait(96_000)

    const summary = await getQueueWaits(run, OP, since())
    expect(summary.measured).toBe(10)
    expect(summary.medianMs).toBe(300)
    expect(summary.maxMs).toBe(96_000)
    expect(summary.slow).toBe(1)
  })

  it('counts every run over the threshold, and takes the threshold as given', async () => {
    await wait(1_000)
    await wait(20_000)
    await wait(30_000)

    expect((await getQueueWaits(run, OP, since())).slow).toBe(2)
    expect((await getQueueWaits(run, OP, since(), { slowerThanMs: 25_000 })).slow).toBe(1)
  })

  it('ignores runs from before the window', async () => {
    await wait(5_000)
    await db.exec(`update agent_runs set created_at = now() - interval '9 days'`)
    expect((await getQueueWaits(run, OP, since())).measured).toBe(0)
  })
})
