import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { listStuckWork, reapStaleDispatching, retryFailedSend, retryOutboxRow } from '../src/failures.ts'
import type { QueryRunner } from '../src/relay.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)),'..','..','db','migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

const addMessage = async (state: string, age = '0 seconds') => {
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state, created_at, error_detail)
     values ($1, $2, 'outbound', 'text', 'reply', $3::delivery_state, now() - $4::interval, 'boom') returning id`,
    [OPERATOR, CONVERSATION, state, age],
  )
  return rows[0]!.id as string
}

const stateOf = async (id: string) =>
  (await run('select delivery_state from messages where id = $1', [id]))[0]!['delivery_state']

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONVERSATION}', '${OPERATOR}', '55555555-5555-5555-5555-555555555555',
            '33333333-3333-3333-3333-333333333333');
  `)
})

describe('seeing what is stuck', () => {
  it('reports nothing when all is well', async () => {
    expect(await listStuckWork(run)).toEqual([])
  })

  it('surfaces dead outbox rows, failed sends and ambiguous sends', async () => {
    await run(`insert into outbox (operator_id, event_type, payload, status, last_error)
               values ($1, 'dispatch_outbound', '{}'::jsonb, 'dead', 'queue refused')`, [OPERATOR])
    await addMessage('failed')
    await addMessage('unknown')
    await run(`insert into inbound_events (operator_id, whatsapp_account_id, provider_event_key, payload, status, last_error)
               values ($1, '33333333-3333-3333-3333-333333333333', 'k1', '{}'::jsonb, 'failed', 'parse error')`, [OPERATOR])

    const kinds = (await listStuckWork(run)).map((i) => i.kind).sort()
    expect(kinds).toEqual(['ambiguous_send', 'dead_outbox', 'failed_inbound_event', 'failed_send'])
  })

  /** The distinction the whole failure view exists to make. */
  it('marks ambiguous sends as unsafe to retry and failed sends as safe', async () => {
    await addMessage('failed')
    await addMessage('unknown')
    const items = await listStuckWork(run)

    expect(items.find((i) => i.kind === 'failed_send')!.safeToRetry).toBe(true)
    expect(items.find((i) => i.kind === 'ambiguous_send')!.safeToRetry).toBe(false)
  })

  it('ignores healthy messages', async () => {
    await addMessage('delivered')
    await addMessage('pending')
    expect(await listStuckWork(run)).toEqual([])
  })
})

describe('reaping interrupted dispatches', () => {
  /** A worker killed mid-send leaves the row claimed forever. */
  it('moves a stale dispatching row to unknown, not back to pending', async () => {
    const id = await addMessage('dispatching', '10 minutes')
    expect(await reapStaleDispatching(run)).toEqual({ reaped: 1 })
    expect(await stateOf(id)).toBe('unknown')

    const row = (await run('select error_code from messages where id = $1', [id]))[0]!
    expect(row['error_code']).toBe('dispatch_interrupted')
  })

  it('leaves a dispatch that is still in progress alone', async () => {
    const id = await addMessage('dispatching', '5 seconds')
    expect(await reapStaleDispatching(run)).toEqual({ reaped: 0 })
    expect(await stateOf(id)).toBe('dispatching')
  })

  it('is safe to run repeatedly', async () => {
    await addMessage('dispatching', '10 minutes')
    await reapStaleDispatching(run)
    expect(await reapStaleDispatching(run)).toEqual({ reaped: 0 })
  })
})

describe('retrying', () => {
  it('requeues a dead outbox row', async () => {
    const rows = await run(`insert into outbox (operator_id, event_type, payload, status, attempts, last_error)
                            values ($1, 'dispatch_outbound', '{}'::jsonb, 'dead', 10, 'boom') returning id`, [OPERATOR])
    const id = rows[0]!.id as string

    expect(await retryOutboxRow(run, id)).toEqual({ retried: true })
    const row = (await run('select status, attempts, last_error from outbox where id = $1', [id]))[0]!
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
  })

  it('requeues a failed send with a fresh dispatch job', async () => {
    const id = await addMessage('failed')
    expect(await retryFailedSend(run, id)).toEqual({ retried: true })
    expect(await stateOf(id)).toBe('pending')

    const jobs = await run(`select event_type, aggregate_id from outbox`, [])
    expect(jobs[0]).toMatchObject({ event_type: 'dispatch_outbound', aggregate_id: id })
  })

  /**
   * The important refusal. Meta may have delivered this already; a retry
   * button next to the others would send the customer the same message twice.
   */
  it('refuses to retry a send whose outcome is unknown', async () => {
    const id = await addMessage('unknown')
    expect(await retryFailedSend(run, id)).toEqual({ retried: false, reason: 'refused_ambiguous' })
    expect(await stateOf(id)).toBe('unknown')
    expect(await run('select id from outbox', [])).toEqual([])
  })

  it('refuses to retry a message that already went', async () => {
    const id = await addMessage('delivered')
    expect(await retryFailedSend(run, id)).toEqual({ retried: false, reason: 'not_retryable' })
  })

  it('reports an unknown id rather than silently doing nothing', async () => {
    expect(await retryFailedSend(run, '77777777-7777-7777-7777-777777777777'))
      .toEqual({ retried: false, reason: 'not_found' })
  })
})
