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
  for (const [topic, answer] of [
    ['follow-up-message', 'Just checking whether you are still looking at those dates.'],
    ['follow-up-message-2', 'The green one is still free that week if it helps.'],
  ] as const) {
    const draft = await draftKnowledge(run, {
      operatorId: OP, topic, answer, confirmedBy: 'Owner',
    })
    await publishKnowledge(transact, { operatorId: OP, entryId: draft.id, membershipId: SARA })
    await run(
      `update knowledge_entries set effective_from = now() - interval '1 day' where id = $1`,
      [draft.id],
    )
  }
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
   * The two gaps are not proportional. The first catches somebody still
   * holding their phone; the second catches them later in the day, and does
   * not get shorter because the first one was quick. Multiplying them produced
   * three messages inside ninety-five minutes.
   */
  it('waits hours before the second, however short the first was', async () => {
    await run(`update operators set follow_up_after_minutes = 5 where id = $1`, [OP])
    await scheduleDue(1)
    await sendDueFollowUps(run, silently)

    const [second] = await run(
      `select round(extract(epoch from due_at - now()) / 60)::int as minutes
       from follow_ups where attempt = 2`, [],
    )
    expect(second!['minutes']).toBe(240)
  })

  it('leaves a long opening gap even longer', async () => {
    await run(`update operators set follow_up_after_minutes = 360 where id = $1`, [OP])
    await scheduleDue(1)
    await sendDueFollowUps(run, silently)

    const [second] = await run(
      `select round(extract(epoch from due_at - now()) / 60)::int as minutes
       from follow_ups where attempt = 2`, [],
    )
    expect(second!['minutes']).toBe(720)
  })

  /**
   * Live, "Still thinking about those dates?" arrived at 7:02 and again at
   * 7:32, word for word. A machine repeats itself.
   */
  it('says something different the second time', async () => {
    await scheduleDue(1)
    await sendDueFollowUps(run, silently)
    await run(`update follow_ups set due_at = now() - interval '1 minute' where attempt = 2`, [])
    await sendDueFollowUps(run, silently)

    const sent = await run(
      `select body from messages where direction = 'outbound' order by created_at`, [],
    )
    expect(sent).toHaveLength(2)
    expect(sent[0]!['body']).not.toBe(sent[1]!['body'])
  })

  /** Nothing published for the later attempt is a task, not a repeat. */
  it('asks a person rather than sending the first message again', async () => {
    await run(`delete from knowledge_entries where topic = 'follow-up-message-2'`, [])
    await scheduleDue(2)

    expect(await sendDueFollowUps(run, silently)).toMatchObject({ sent: 0, raisedForAPerson: 1 })
  })

  /**
   * The wording is a different published answer from the rule about timing,
   * and they were the same field until a note to the team — "follow up once
   * after four hours" — came within hours of being sent to a customer.
   */
  it('sends nothing at all when only the timing rule is published', async () => {
    await run(
      `update knowledge_entries set topic = 'follow-up-timing' where topic = 'follow-up-message'`,
      [],
    )
    await scheduleDue(1)

    const swept = await sendDueFollowUps(run, silently)
    expect(swept).toMatchObject({ sent: 0, raisedForAPerson: 1 })
  })

  /**
   * A lead that stopped replying is not a lead that went away. The last
   * automatic message is where it becomes somebody's to call, rather than where
   * it quietly stops existing.
   */
  it('hands the second to a person rather than chasing a third time', async () => {
    await scheduleDue(2)

    const swept = await sendDueFollowUps(run, silently)

    expect(swept).toMatchObject({ sent: 1, rescheduled: 0, raisedForAPerson: 1 })
    expect(await chases()).toEqual([{ attempt: 2, state: 'sent' }])

    const [handoff] = await run(`select summary from handoffs`, [])
    expect(String(handoff!['summary'])).toContain('Chased 2 times')
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
