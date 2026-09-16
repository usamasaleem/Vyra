import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { sendDueFollowUps } from '../src/follow-ups.ts'
import { scheduleFollowUp } from '../../db/src/queries/follow-ups.ts'
import { draftKnowledge, publishKnowledge } from '../../db/src/queries/knowledge.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

/**
 * The sweep, end to end — and specifically what happens after a chase is sent.
 *
 * Until now, nothing did. `attempt` existed in the schema and nothing ever
 * incremented it, so a customer who went quiet was chased once and then never
 * contacted again by anything. Follow-ups are the only automatic outbound
 * message in this system, which made that the point where a lead stopped
 * existing without anybody deciding to let it.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor
const silently = () => {}

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
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id,
                              last_customer_message_at)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}', now() - interval '4 hours');
  `)

  // Without an approved policy there is no wording to send, and every chase
  // becomes a task for a person instead. That path is the operator's to fix.
  const draft = await draftKnowledge(run, {
    operatorId: OP, topic: 'follow-up-timing',
    answer: 'Just checking whether you are still looking at those dates.',
    confirmedBy: 'Owner',
  })
  await publishKnowledge(transact, { operatorId: OP, entryId: draft.id, membershipId: SARA })
  await run(
    `update knowledge_entries set effective_from = now() - interval '1 day' where id = $1`,
    [draft.id],
  )
})

const scheduleDue = async (attempt = 1) => {
  await scheduleFollowUp(run, {
    operatorId: OP, conversationId: CONV, reason: 'awaiting_customer', afterMinutes: 240, attempt,
  })
  await run(
    `update follow_ups set due_at = now() - interval '1 minute'
     where conversation_id = $1 and state = 'scheduled'`,
    [CONV],
  )
}

const chases = () =>
  run(`select attempt, state from follow_ups order by attempt, created_at`, [])

describe('chasing more than once', () => {
  it('sends the first chase and lines up the second', async () => {
    await scheduleDue(1)

    const swept = await sendDueFollowUps(run, silently)

    expect(swept).toMatchObject({ sent: 1, rescheduled: 1, raisedForAPerson: 0 })
    expect(await chases()).toEqual([
      { attempt: 1, state: 'sent' },
      { attempt: 2, state: 'scheduled' },
    ])
  })

  /**
   * The gaps are shaped by the 24-hour window rather than by taste: four hours
   * after the reply, then six, then ten is twenty hours after the customer last
   * wrote, with the window closing at twenty-four.
   */
  it('leaves six hours before the second and ten before the third', async () => {
    await scheduleDue(1)
    await sendDueFollowUps(run, silently)

    const [second] = await run(
      `select round(extract(epoch from due_at - now()) / 3600)::int as hours
       from follow_ups where attempt = 2`, [],
    )
    expect(second!['hours']).toBe(6)

    await run(`update follow_ups set due_at = now() - interval '1 minute' where attempt = 2`, [])
    await sendDueFollowUps(run, silently)

    const [third] = await run(
      `select round(extract(epoch from due_at - now()) / 3600)::int as hours
       from follow_ups where attempt = 3`, [],
    )
    expect(third!['hours']).toBe(10)
  })

  /**
   * A lead that stopped replying is not a lead that went away. The last
   * automatic message is where it becomes somebody's to call, rather than where
   * it quietly stops existing.
   */
  it('hands the third to a person rather than chasing a fourth time', async () => {
    await scheduleDue(3)

    const swept = await sendDueFollowUps(run, silently)

    expect(swept).toMatchObject({ sent: 1, rescheduled: 0, raisedForAPerson: 1 })
    expect(await chases()).toEqual([{ attempt: 3, state: 'sent' }])

    const [handoff] = await run(`select summary from handoffs`, [])
    expect(String(handoff!['summary'])).toContain('Chased 3 times')
  })

  /** Everything that stops a chase is re-checked when the next one is scheduled. */
  it('does not line up another after somebody takes the conversation over', async () => {
    await scheduleDue(1)
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])

    expect(await sendDueFollowUps(run, silently)).toMatchObject({ sent: 0, rescheduled: 0 })
  })

  it('sends the operator own words, not a composed message', async () => {
    await scheduleDue(1)
    await sendDueFollowUps(run, silently)

    const [message] = await run(
      `select body from messages where direction = 'outbound' order by created_at desc limit 1`, [],
    )
    expect(message!['body']).toBe('Just checking whether you are still looking at those dates.')
  })
})
