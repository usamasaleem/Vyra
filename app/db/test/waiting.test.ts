import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  escalateAbandonedConversations, listCustomersWaitingOnAPerson, resumeAbandonedConversations,
} from '../src/queries/waiting.ts'
import { acceptHandoff, raiseHandoff } from '../src/queries/handoff-queue.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, handoff_sla_minutes)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', 30);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Layla');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id, handler_mode)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}', 'human');
  `)
})

const say = (direction: 'inbound' | 'outbound', body: string, minutesAgo = 0) =>
  run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, created_at)
     values ($1, $2, $3::message_direction, 'text', $4, $5, now() - make_interval(mins => $6))`,
    [OP, CONV, direction, body, `wamid.${Math.random()}`, minutesAgo],
  )

describe('listCustomersWaitingOnAPerson', () => {
  /** The case from a live evening: handed over, then asked one more thing. */
  it('finds a customer whose last message nobody answered', async () => {
    await say('outbound', 'A colleague will come back to you.', 40)
    await say('inbound', "what's the deposit?", 35)

    const waiting = await listCustomersWaitingOnAPerson(run, { operatorId: OP })
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      conversationId: CONV, contactName: 'Layla', lastCustomerMessage: "what's the deposit?",
    })
    expect(waiting[0]!.waitingMinutes).toBeGreaterThanOrEqual(34)
  })

  it('stops counting once somebody replies', async () => {
    await say('inbound', "what's the deposit?", 35)
    await say('outbound', 'AED 5,000, released after 14 days.', 2)

    expect(await listCustomersWaitingOnAPerson(run, { operatorId: OP })).toHaveLength(0)
  })

  /** The AI owns this one, so nobody is being kept waiting by a person. */
  it('ignores a conversation the AI still owns', async () => {
    await run(`update conversations set handler_mode = 'ai' where id = $1`, [CONV])
    await say('inbound', 'hello?', 35)

    expect(await listCustomersWaitingOnAPerson(run, { operatorId: OP })).toHaveLength(0)
  })

  /** Somebody who asked not to be messaged is not waiting for a reply. */
  it('ignores a contact who opted out', async () => {
    await run(`update contacts set opted_out_at = now() where id = $1`, [CONTACT])
    await say('inbound', 'stop', 35)

    expect(await listCustomersWaitingOnAPerson(run, { operatorId: OP })).toHaveLength(0)
  })

  it('can be asked for only the ones waiting a while', async () => {
    await say('inbound', 'just now', 2)
    expect(await listCustomersWaitingOnAPerson(run, { operatorId: OP, minimumMinutes: 30 }))
      .toHaveLength(0)
  })
})

describe('escalateAbandonedConversations', () => {
  const acceptedHandoff = async () => {
    const { handoffId } = await raiseHandoff(run, {
      operatorId: OP, conversationId: CONV, reason: 'customer_asked', summary: 'Wants a person.',
    })
    await acceptHandoff(run, { operatorId: OP, handoffId: handoffId!, membershipId: SARA })
    return handoffId!
  }

  /**
   * A handoff somebody accepted stops being visible, which is right until they
   * stop replying — at which point "theirs" and "lost" look identical from the
   * queue, and identical to the customer too.
   */
  it('puts an ignored conversation back in the queue', async () => {
    const handoffId = await acceptedHandoff()
    await say('inbound', 'any update?', 45)

    const reopened = await escalateAbandonedConversations(run)
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toMatchObject({ handoffId, conversationId: CONV })

    const [row] = await run(`select state::text as state, owner_membership_id from handoffs`, [])
    // Owner kept: knowing who let it go is part of why this is worth recording.
    expect(row).toMatchObject({ state: 'escalated', owner_membership_id: SARA })
  })

  it('leaves it alone while the customer is still inside the SLA', async () => {
    await acceptedHandoff()
    await say('inbound', 'any update?', 5)

    expect(await escalateAbandonedConversations(run)).toHaveLength(0)
  })

  it('leaves it alone once the salesperson has replied', async () => {
    await acceptedHandoff()
    await say('inbound', 'any update?', 45)
    await say('outbound', 'Sorry for the wait — here you go.', 1)

    expect(await escalateAbandonedConversations(run)).toHaveLength(0)
  })

  it('does not escalate a handoff nobody accepted, which the other sweep owns', async () => {
    await raiseHandoff(run, {
      operatorId: OP, conversationId: CONV, reason: 'customer_asked', summary: 'Wants a person.',
    })
    await say('inbound', 'any update?', 45)

    expect(await escalateAbandonedConversations(run)).toHaveLength(0)
  })
})

/**
 * Taking a conversation back from a salesperson who stopped answering.
 *
 * From the pilot: a customer asked about a discount, was told a person would
 * come back, and heard nothing for thirty-five hours. Nothing would ever have
 * spoken to them again — a conversation in human hands schedules no follow-up,
 * because follow-ups are scheduled by the turn that does not run.
 */
describe('resumeAbandonedConversations', () => {
  const own = () =>
    run(`update conversations set owner_membership_id = $1 where id = $2`, [SARA, CONV])

  const modeOf = async () =>
    (await run(`select handler_mode, owner_membership_id, ai_resumed_at from conversations where id = $1`, [CONV]))[0]!

  it('leaves a conversation somebody is still answering alone', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 200)
    await say('outbound', 'Let me ask the manager.', 190)

    expect(await resumeAbandonedConversations(run)).toEqual([])
    expect((await modeOf())['handler_mode']).toBe('human')
  })

  it('leaves a customer who has only just written alone', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 5)

    expect(await resumeAbandonedConversations(run)).toEqual([])
  })

  it('takes it back once the customer has waited past the threshold', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)

    const [back] = await resumeAbandonedConversations(run)
    expect(back).toMatchObject({ conversationId: CONV, ownerMembershipId: SARA })
    expect(back!.waitingMinutes).toBeGreaterThanOrEqual(119)
    expect((await modeOf())['handler_mode']).toBe('ai')
  })

  /**
   * The owner stays. A deliberate handback clears it because that person has
   * finished; this is the absence of a decision, and the inbox should still
   * say who the conversation was left with.
   */
  it('keeps the owner on the conversation', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)
    await resumeAbandonedConversations(run)

    expect((await modeOf())['owner_membership_id']).toBe(SARA)
  })

  /** Otherwise the customer is answered by nobody: the handback alone sends nothing. */
  it('queues the unanswered message so it actually gets a reply', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)
    const [back] = await resumeAbandonedConversations(run)

    const [job] = await run(
      `select event_type, aggregate_id from outbox where event_type = 'process_inbound_message'`, [],
    )
    expect(job!['aggregate_id']).toBe(back!.waitingMessageId)
  })

  it('leaves a note so the salesperson finds out', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)
    await resumeAbandonedConversations(run)

    const [note] = await run(`select body, author_membership_id from conversation_notes`, [])
    expect(String(note!['body'])).toContain('taken the conversation back')
    expect(note!['author_membership_id']).toBeNull()
  })

  it('records it as something the system did, not a person', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)
    await resumeAbandonedConversations(run)

    const [event] = await run(
      `select actor_type, action from audit_events where action = 'conversation.resumed_after_silence'`, [],
    )
    expect(event!['actor_type']).toBe('system')
  })

  /**
   * The loop guard, and the reason this is safe at all. An agent that answers
   * and hands straight back to a person must not take the same unanswered
   * question again on the next sweep.
   */
  it('does not take the same message back twice', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 120)
    expect(await resumeAbandonedConversations(run)).toHaveLength(1)

    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    expect(await resumeAbandonedConversations(run)).toEqual([])
  })

  /** A new question after a new takeover is a new silence. */
  it('takes it back again for a later message', async () => {
    await own()
    await say('inbound', 'can you do 3000?', 300)
    await resumeAbandonedConversations(run)

    // The first handback happened when that message came due, not now — the
    // guard compares two moments in time and the test has to respect the order
    // they really occur in.
    await run(
      `update conversations set handler_mode = 'human',
              ai_resumed_at = now() - make_interval(mins => 200) where id = $1`,
      [CONV],
    )
    await say('inbound', 'any news?', 90)

    expect(await resumeAbandonedConversations(run)).toHaveLength(1)
  })

  it('never speaks to somebody who opted out', async () => {
    await own()
    await run(`update contacts set opted_out_at = now() where id = $1`, [CONTACT])
    await say('inbound', 'stop messaging me', 120)

    expect(await resumeAbandonedConversations(run)).toEqual([])
  })

  /** An operator who wants a person to handle it however long that takes. */
  it('does nothing for an operator that switched it off', async () => {
    await own()
    await run(`update operators set ai_resumes_after_minutes = null where id = $1`, [OP])
    await say('inbound', 'can you do 3000?', 300)

    expect(await resumeAbandonedConversations(run)).toEqual([])
  })

  it('honours the operator own threshold', async () => {
    await own()
    await run(`update operators set ai_resumes_after_minutes = 240 where id = $1`, [OP])
    await say('inbound', 'can you do 3000?', 120)
    expect(await resumeAbandonedConversations(run)).toEqual([])

    await run(`update operators set ai_resumes_after_minutes = 90 where id = $1`, [OP])
    expect(await resumeAbandonedConversations(run)).toHaveLength(1)
  })
})
