import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { acceptTurnOutput, recordRejectedTurn } from '../src/queries/turn-output.ts'
import { takeOverConversation } from '../src/queries/takeover.ts'
import { recordOptOut } from '../src/queries/opt-out.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
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
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const turn = (revisionAtTurnStart: number, body = 'Friday it is — shall I hold the Ferrari?') =>
  acceptTurnOutput(transact, {
    conversationId: CONV, operatorId: OP, revisionAtTurnStart, body, idempotencyKey: 'turn:1',
  })

async function revision(): Promise<number> {
  const [row] = await run(`select revision from conversations where id = $1`, [CONV])
  return Number(row!['revision'])
}

describe('accepting a turn', () => {
  it('queues the reply when nothing moved', async () => {
    const result = await turn(await revision())
    expect(result).toMatchObject({ accepted: true })

    const [message] = await run(
      `select body, delivery_state::text as state, revision_at_send
       from messages where conversation_id = $1 and direction = 'outbound'`,
      [CONV],
    )
    expect(message).toMatchObject({ state: 'pending', revision_at_send: 0 })
  })

  it('creates an outbox job alongside, so the reply will actually be attempted', async () => {
    await turn(await revision())
    const jobs = await run(`select event_type from outbox where operator_id = $1`, [OP])
    expect(jobs).toEqual([{ event_type: 'dispatch_outbound' }])
  })
})

/**
 * The duplicate the pilot produced, and the one case the revision check cannot
 * see.
 *
 * A stranger opened a conversation with "Hy", then "I want a car" a second and
 * a half later. The second message bumped the revision before either turn had
 * started, so both turns began at the same number, both looked current, and
 * the customer got the fleet list twice seven seconds apart.
 *
 * The revision answers "has the conversation changed since I began". This
 * answers the question that was actually being asked: "is this still the live
 * question".
 */
describe('a turn overtaken before it began', () => {
  const say = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return rows[0]!['id'] as string
  }

  const answering = (messageId: string, revisionAtTurnStart: number) =>
    acceptTurnOutput(transact, {
      conversationId: CONV, operatorId: OP, revisionAtTurnStart,
      answeringMessageId: messageId,
      body: 'Nice — we have three cars.',
      idempotencyKey: `turn:${messageId}`,
      destination: 'send',
    })

  it('discards the answer to a question they have already moved past', async () => {
    const first = await say('Hy')
    await say('I want a car')

    // Both turns start at the same revision, which is exactly why the revision
    // check cannot separate them.
    expect(await answering(first, 0)).toMatchObject({ accepted: false, reason: 'overtaken' })
  })

  it('accepts the answer to the newest message', async () => {
    await say('Hy')
    const second = await say('I want a car')
    expect(await answering(second, 0)).toMatchObject({ accepted: true })
  })

  it('accepts when nothing has come in behind it', async () => {
    const only = await say('Hy')
    expect(await answering(only, 0)).toMatchObject({ accepted: true })
  })

  /**
   * An outbound message in between is not the customer saying something else.
   */
  it('is not tripped by its own earlier reply', async () => {
    const first = await say('Hy')
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'outbound', 'text', 'One moment', $3)`,
      [OP, CONV, `wamid.${Math.random()}`],
    )
    expect(await answering(first, 0)).toMatchObject({ accepted: true })
  })

  /**
   * The acknowledgement paths answer an older message on purpose — a voice note
   * routed to a person still deserves its reply even with three messages behind
   * it — so they do not pass the id at all.
   */
  it('leaves a turn that does not name its message alone', async () => {
    await say('Hy')
    await say('I want a car')
    const result = await acceptTurnOutput(transact, {
      conversationId: CONV, operatorId: OP, revisionAtTurnStart: 0,
      body: "Thanks — I can't read that kind of message.",
      idempotencyKey: 'non-text:x', destination: 'send', ownHandoff: true,
    })
    expect(result).toMatchObject({ accepted: true })
  })
})

describe('rejecting a turn', () => {
  /**
   * The case this whole mechanism exists for. The model was told Friday, and
   * while it was writing, the customer said Saturday.
   */
  it('discards a reply written before the customer corrected themselves', async () => {
    const startedAt = await revision()
    await run(`update conversations set revision = revision + 1 where id = $1`, [CONV])

    const result = await turn(startedAt)
    expect(result).toMatchObject({ accepted: false, reason: 'superseded', revisionNow: 1 })

    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)
  })

  it('discards a reply written before a salesperson took over', async () => {
    const startedAt = await revision()
    await takeOverConversation(run, { conversationId: CONV, operatorId: OP, membershipId: MEMBER })

    const result = await turn(startedAt)
    // Takeover also moves the revision, so both checks would catch it. The
    // reason reported is the one a person can act on.
    expect(result).toMatchObject({ accepted: false, reason: 'human_took_over' })
  })

  it('discards a reply to someone who asked not to be messaged', async () => {
    const startedAt = await revision()
    await recordOptOut(run, {
      contactId: CONTACT, operatorId: OP, conversationId: CONV,
      matched: 'stop', messageId: '00000000-0000-0000-0000-000000000000',
    })

    const result = await turn(startedAt)
    expect(result).toMatchObject({ accepted: false })
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)
  })

  it('reports a conversation that no longer exists rather than throwing', async () => {
    const result = await acceptTurnOutput(transact, {
      conversationId: '99999999-9999-9999-9999-999999999999',
      operatorId: OP, revisionAtTurnStart: 0, body: 'hello', idempotencyKey: 'turn:x',
    })
    expect(result).toMatchObject({ accepted: false, reason: 'conversation_gone', revisionNow: null })
  })

  /** A discarded turn leaves no message, so the audit trail is the only record. */
  it('is answerable afterwards', async () => {
    await recordRejectedTurn(transact, {
      conversationId: CONV, operatorId: OP, reason: 'superseded',
      revisionAtTurnStart: 0, revisionNow: 1,
    })
    const [audit] = await run(
      `select action, subject_version, data, actor_type::text as actor from audit_events where subject_id = $1`,
      [CONV],
    )
    expect(audit).toMatchObject({ action: 'turn.rejected', subject_version: 1, actor: 'ai' })
    expect((audit!['data'] as Record<string, unknown>)['reason']).toBe('superseded')
  })
})

describe('the check that could silently become a no-op', () => {
  /**
   * Reading the revision *after* the model runs instead of before makes every
   * comparison succeed, and the mechanism looks like it is working while
   * protecting nothing. This asserts the failure is visible: a turn started at
   * the older revision is rejected, where one "started" at the current one is
   * not.
   */
  it('only protects a turn whose revision was captured before the model ran', async () => {
    const beforeTheModel = await revision()
    await run(`update conversations set revision = revision + 1 where id = $1`, [CONV])
    const afterTheModel = await revision()

    expect(await turn(beforeTheModel)).toMatchObject({ accepted: false, reason: 'superseded' })
    expect(await turn(afterTheModel)).toMatchObject({ accepted: true })
  })
})
