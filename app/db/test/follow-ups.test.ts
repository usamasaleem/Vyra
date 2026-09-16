import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cancelFollowUps, findDueFollowUps, listFollowUpsNeedingAttention,
  markFollowUpNeedsAPerson, markFollowUpSent, scheduleFollowUp,
} from '../src/queries/follow-ups.ts'
import { recordOptOut } from '../src/queries/opt-out.ts'
import { takeOverConversation } from '../src/queries/takeover.ts'
import { draftKnowledge, publishKnowledge } from '../src/queries/knowledge.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
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
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id,
                              last_customer_message_at)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}', now());
  `)
})

const schedule = (afterMinutes = 240) =>
  scheduleFollowUp(run, {
    operatorId: OP, conversationId: CONV, reason: 'awaiting_customer', afterMinutes,
  })

const makeDue = () =>
  run(`update follow_ups set due_at = now() - interval '1 minute' where conversation_id = $1`, [CONV])

async function publishPolicy(answer: string) {
  const draft = await draftKnowledge(run, {
    operatorId: OP, topic: 'follow-up-message', answer, confirmedBy: 'Owner',
  })
  await publishKnowledge(transact, { operatorId: OP, entryId: draft.id, membershipId: SARA })
  await run(
    `update knowledge_entries set effective_from = now() - interval '1 day' where id = $1`,
    [draft.id],
  )
}

describe('scheduling', () => {
  it('schedules one chase per conversation, not one per message', async () => {
    const first = await schedule()
    const second = await schedule()
    expect(first.scheduled).toBe(true)
    expect(second.scheduled).toBe(false)
    expect(await run(`select id from follow_ups`, [])).toHaveLength(1)
  })

  it.each([
    ['a person has taken over', `update conversations set handler_mode = 'human' where id = '${CONV}'`],
    ['the lead is won', `update conversations set sales_stage = 'won' where id = '${CONV}'`],
    ['the lead is lost', `update conversations set sales_stage = 'lost' where id = '${CONV}'`],
    ['the customer opted out', `update contacts set opted_out_at = now() where id = '${CONTACT}'`],
  ])('does not schedule when %s', async (_label, sql) => {
    await run(sql, [])
    expect((await schedule()).scheduled).toBe(false)
  })
})

describe('stopping', () => {
  it('stops when the customer replies', async () => {
    await schedule()
    const result = await cancelFollowUps(run, {
      operatorId: OP, conversationId: CONV, reason: 'customer_replied',
    })
    expect(result).toMatchObject({ cancelled: 1 })
    expect(await findDueFollowUps(run)).toHaveLength(0)
  })

  /** Chasing somebody who asked for silence is how a number gets reported. */
  it('stops on an opt-out, inside the same statement', async () => {
    await schedule()
    await recordOptOut(run, {
      contactId: CONTACT, operatorId: OP, conversationId: CONV,
      matched: 'stop', messageId: '00000000-0000-0000-0000-000000000000',
    })
    const [row] = await run(`select state::text as state, cancelled_reason from follow_ups`, [])
    expect(row).toMatchObject({ state: 'cancelled', cancelled_reason: 'opted_out' })
  })

  it('stops when a salesperson takes over', async () => {
    await schedule()
    await takeOverConversation(run, { conversationId: CONV, operatorId: OP, membershipId: SARA })
    const [row] = await run(`select state::text as state, cancelled_reason from follow_ups`, [])
    expect(row).toMatchObject({ state: 'cancelled', cancelled_reason: 'taken_over' })
  })
})

describe('what is due', () => {
  it('is not due before its time', async () => {
    await schedule()
    expect(await findDueFollowUps(run)).toHaveLength(0)
  })

  /**
   * Eligibility is re-evaluated at send time, not trusted from scheduling. Hours
   * pass between the two and everything that matters can change in them.
   */
  it('drops out when the conversation changed after scheduling', async () => {
    await schedule()
    await makeDue()
    expect(await findDueFollowUps(run)).toHaveLength(1)

    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    expect(await findDueFollowUps(run)).toHaveLength(0)
  })

  it('reports no approved policy when none is published', async () => {
    await schedule()
    await makeDue()
    const [item] = await findDueFollowUps(run)
    expect(item!.approvedPolicy).toBeNull()
  })

  it('carries the operator own approved wording when there is one', async () => {
    await publishPolicy('Just checking in — are those dates still what you need?')
    await schedule()
    await makeDue()
    const [item] = await findDueFollowUps(run)
    expect(item!.approvedPolicy).toBe('Just checking in — are those dates still what you need?')
  })

  /** Free-form sending is not permitted outside 24 hours, at all. */
  it('knows when the sending window has closed', async () => {
    await run(
      `update conversations set last_customer_message_at = now() - interval '30 hours' where id = $1`,
      [CONV],
    )
    await schedule()
    await makeDue()
    const [item] = await findDueFollowUps(run)
    expect(item!.insideWindow).toBe(false)
  })
})

describe('recording the outcome', () => {
  it('keeps what was actually sent', async () => {
    await schedule()
    await makeDue()
    const [item] = await findDueFollowUps(run)
    await markFollowUpSent(run, {
      followUpId: item!.id, operatorId: OP, body: 'Still interested?', messageId: null,
    })
    const [row] = await run(`select state::text as state, sent_body from follow_ups`, [])
    expect(row).toMatchObject({ state: 'sent', sent_body: 'Still interested?' })
  })

  /** A sent row with no record of what was said is one nobody can check. */
  it('cannot be marked sent with nothing recorded', async () => {
    await schedule()
    await expect(
      run(`update follow_ups set state = 'sent' where conversation_id = $1`, [CONV]),
    ).rejects.toThrow(/follow_ups_sent_is_recorded/)
  })

  it('shows one that needs a person in the inbox list', async () => {
    await schedule()
    await makeDue()
    const [item] = await findDueFollowUps(run)
    await markFollowUpNeedsAPerson(run, {
      followUpId: item!.id, operatorId: OP, reason: 'outside the 24-hour window',
    })
    const [shown] = await listFollowUpsNeedingAttention(run, OP)
    expect(shown).toMatchObject({ state: 'needs_a_person' })
  })
})
