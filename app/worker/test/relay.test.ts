import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  publishToGraphileWorker,
  relayOnce,
  type OutboxRow,
  type Publisher,
  type QueryRunner,
  type Transactor,
} from '../src/relay.ts'

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..','..','db','migrations',
)
const OPERATOR = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let transact: Transactor
let run: QueryRunner

const addOutboxRow = async (payload: Record<string, unknown> = { message_id: 'm1', conversation_id: 'c1' }) => {
  const rows = await run(
    `insert into outbox (operator_id, event_type, payload) values ($1, 'process_inbound_message', $2::jsonb) returning id`,
    [OPERATOR, JSON.stringify(payload)],
  )
  return rows[0]!.id as string
}

const outboxState = async (id: string) =>
  (await run('select status, attempts, last_error, next_attempt_at, published_at from outbox where id = $1', [id]))[0]!

beforeEach(async () => {
  db = await PGlite.create()
  run = async (text, params) => (await db.query(text, params)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot');`)
})

const noopPublisher: Publisher = async () => {}
const failingPublisher: Publisher = async () => {
  throw new Error('queue unavailable')
}

describe('relaying pending work', () => {
  it('publishes a pending row and marks it published', async () => {
    const id = await addOutboxRow()
    const result = await relayOnce(transact, noopPublisher)

    expect(result).toMatchObject({ claimed: 1, published: 1, deferred: 0, dead: 0 })
    const state = await outboxState(id)
    expect(state.status).toBe('published')
    expect(state.published_at).not.toBeNull()
  })

  it('does nothing when the outbox is empty', async () => {
    expect(await relayOnce(transact, noopPublisher)).toMatchObject({ claimed: 0, published: 0 })
  })

  it('never claims a row twice', async () => {
    await addOutboxRow()
    await relayOnce(transact, noopPublisher)
    expect(await relayOnce(transact, noopPublisher)).toMatchObject({ claimed: 0 })
  })

  it('passes the row through to the publisher intact', async () => {
    await addOutboxRow({ message_id: 'm-42', conversation_id: 'c-7' })
    const seen: OutboxRow[] = []
    await relayOnce(transact, async (_tx, row) => { seen.push(row) })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      operator_id: OPERATOR,
      event_type: 'process_inbound_message',
      attempts: 0,
      payload: { message_id: 'm-42', conversation_id: 'c-7' },
    })
  })
})

describe('when publishing fails', () => {
  it('leaves the row pending and records why', async () => {
    const id = await addOutboxRow()
    const result = await relayOnce(transact, failingPublisher)

    expect(result).toMatchObject({ claimed: 1, published: 0, deferred: 1, dead: 0 })
    const state = await outboxState(id)
    expect(state.status).toBe('pending')
    expect(state.attempts).toBe(1)
    expect(state.last_error).toContain('queue unavailable')
  })

  it('backs off rather than retrying immediately', async () => {
    const id = await addOutboxRow()
    await relayOnce(transact, failingPublisher)

    const state = await outboxState(id)
    expect(new Date(state.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now())
    // Deferred work is not visible to the next pass.
    expect(await relayOnce(transact, failingPublisher)).toMatchObject({ claimed: 0 })
  })

  it('recovers when the queue comes back', async () => {
    const id = await addOutboxRow()
    await relayOnce(transact, failingPublisher)
    await run(`update outbox set next_attempt_at = now() where id = $1`, [id])

    expect(await relayOnce(transact, noopPublisher)).toMatchObject({ published: 1 })
    expect((await outboxState(id)).status).toBe('published')
  })

  /** A failure nobody can see is indistinguishable from a lost message. */
  it('gives up after ten attempts and leaves the row visible as dead', async () => {
    const id = await addOutboxRow()
    for (let i = 0; i < 10; i++) {
      await run(`update outbox set next_attempt_at = now() where id = $1`, [id])
      await relayOnce(transact, failingPublisher)
    }
    const state = await outboxState(id)
    expect(state.status).toBe('dead')
    expect(state.attempts).toBe(10)
    // Dead rows are not retried silently.
    expect(await relayOnce(transact, failingPublisher)).toMatchObject({ claimed: 0 })
  })

  it('does not let one poisonous row block the rest of the batch', async () => {
    const poison = await addOutboxRow({ message_id: 'poison', conversation_id: 'c1' })
    const healthy = await addOutboxRow({ message_id: 'fine', conversation_id: 'c2' })

    await relayOnce(transact, async (_tx, row) => {
      if (row.payload['message_id'] === 'poison') throw new Error('bad payload')
    })

    expect((await outboxState(poison)).status).toBe('pending')
    expect((await outboxState(healthy)).status).toBe('published')
  })
})

describe('the graphile-worker publisher', () => {
  it('serialises inbound turns per conversation and collapses them', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const capturing: QueryRunner = async (text, params) => { calls.push({ text, params }); return [] }

    await publishToGraphileWorker(capturing, {
      id: 'outbox-1', operator_id: OPERATOR, event_type: 'process_inbound_message',
      aggregate_id: 'msg-1', payload: { conversation_id: 'conv-9', message_id: 'msg-1' }, attempts: 0,
    })

    expect(calls[0]!.text).toContain('graphile_worker.add_job')
    const [identifier, payload, queueName, jobKey, delayed] = calls[0]!.params as [
      string, string, string, string, boolean,
    ]
    expect(identifier).toBe('process_inbound_message')
    // Per-conversation serialisation: a global concurrency limit cannot do this.
    expect(queueName).toBe('conversation:conv-9')
    /**
     * Build plan step 26. Keyed by conversation rather than outbox row, so a
     * second message two seconds later replaces the pending turn instead of
     * starting a competing one. Keyed by outbox row, four messages in a burst
     * produced four turns and the customer got overlapping replies.
     */
    expect(jobKey).toBe('turn:conv-9')
    expect(delayed).toBe(true)
    expect(calls[0]!.text).toContain("interval '400 milliseconds'")
    expect(JSON.parse(payload)).toMatchObject({
      conversation_id: 'conv-9', message_id: 'msg-1', operator_id: OPERATOR, outbox_id: 'outbox-1',
    })
  })

  /**
   * The two-second window caught a burst zero times across every message the
   * pilot has received, and the gap between consecutive customer messages has
   * a minimum of 4.6 seconds and a median of 32.7. People send, then think,
   * then send again — a window that collapsed real bursts would have to be
   * about thirty seconds, which nobody would trade for.
   *
   * So one window for everything, short enough to be free.
   */
  it('waits the same short moment whatever the message looked like', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const capturing: QueryRunner = async (text, params) => { calls.push({ text, params }); return [] }

    for (const body of [{ looks_finished: true }, { looks_finished: false }, {}]) {
      await publishToGraphileWorker(capturing, {
        id: 'outbox-2', operator_id: OPERATOR, event_type: 'process_inbound_message',
        aggregate_id: 'msg-2',
        payload: { conversation_id: 'conv-9', message_id: 'msg-2', ...body },
        attempts: 0,
      })
    }

    for (const call of calls) {
      expect(call.text).toContain("interval '400 milliseconds'")
      expect(call.text).not.toContain("interval '2 seconds'")
    }
  })

  /**
   * Sends must never collapse. Two outbound messages are two messages a
   * customer is owed, and a conversation-scoped key would silently drop one.
   */
  it('keeps every outbound dispatch distinct, and does not delay it', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const capturing: QueryRunner = async (text, params) => { calls.push({ text, params }); return [] }

    for (const id of ['outbox-1', 'outbox-2']) {
      await publishToGraphileWorker(capturing, {
        id, operator_id: OPERATOR, event_type: 'dispatch_outbound',
        aggregate_id: 'msg', payload: { conversation_id: 'conv-9', message_id: `m-${id}` }, attempts: 0,
      })
    }

    const keys = calls.map((c) => (c.params as string[])[3])
    expect(keys).toEqual(['outbox:outbox-1', 'outbox:outbox-2'])
    expect(calls.every((c) => (c.params as unknown[])[4] === false)).toBe(true)
  })

  it('omits the queue when there is no conversation to serialise on', async () => {
    const calls: unknown[][] = []
    await publishToGraphileWorker(async (_t, p) => { calls.push(p as unknown[]); return [] }, {
      id: 'outbox-2', operator_id: OPERATOR, event_type: 'refresh_inventory',
      aggregate_id: null, payload: {}, attempts: 0,
    })
    expect(calls[0]![2]).toBeNull()
  })
})
