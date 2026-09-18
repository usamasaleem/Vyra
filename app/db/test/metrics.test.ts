import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatDuration, getMetrics } from '../src/queries/metrics.ts'
import { closeLead, flagIncorrectAnswer } from '../src/queries/outcomes.ts'
import { acceptHandoff, raiseHandoff } from '../src/queries/handoff-queue.ts'
import { ensureEnquiry } from '../src/queries/enquiry-fields.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'

let db: PGlite
let run: QueryRunner
const since = () => new Date(Date.now() - 86_400_000)

async function conversation(phone: string): Promise<string> {
  const [c] = await run(
    `insert into contacts (operator_id, channel_identifier) values ($1,$2) returning id`, [OP, phone],
  )
  const [v] = await run(
    `insert into conversations (operator_id, contact_id, whatsapp_account_id) values ($1,$2,$3) returning id`,
    [OP, c!['id'], ACCOUNT],
  )
  return v!['id'] as string
}

const inbound = (conv: string, minutesAgo = 60) =>
  run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, created_at)
     values ($1,$2,'inbound','text','hello', now() - make_interval(mins => $3))`,
    [OP, conv, minutesAgo],
  )

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
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
  `)
})

describe('counting enquiries', () => {
  it('counts conversations that heard from a customer in the window', async () => {
    await inbound(await conversation('971500000001'))
    await inbound(await conversation('971500000002'))
    const m = await getMetrics(run, OP, since())
    expect(m.enquiries).toBe(2)
  })

  it('ignores anything outside the window', async () => {
    await inbound(await conversation('971500000001'), 60 * 24 * 5)
    const m = await getMetrics(run, OP, since())
    expect(m.enquiries).toBe(0)
  })
})

describe('first-response time', () => {
  /**
   * The column existed since schema v1 and nothing wrote it, so this measure
   * had no input at all until the dispatcher started recording it.
   */
  it('measures from the customer message to the reply that was sent', async () => {
    const conv = await conversation('971500000001')
    await inbound(conv, 60)
    await run(
      `update conversations set first_response_at = now() - interval '58 minutes' where id = $1`,
      [conv],
    )
    const m = await getMetrics(run, OP, since())
    // Two minutes.
    expect(m.firstResponseSeconds).toBeGreaterThan(100)
    expect(m.firstResponseSeconds).toBeLessThan(140)
  })

  /** A conversation nobody answered must not count as a fast response. */
  it('is null when nothing was answered', async () => {
    await inbound(await conversation('971500000001'))
    expect((await getMetrics(run, OP, since())).firstResponseSeconds).toBeNull()
  })

  /**
   * One conversation left over a weekend drags a mean far enough to hide a
   * week of fast replies.
   */
  it('is a median, so one slow reply does not hide the rest', async () => {
    for (const [i, lag] of [2, 3, 4, 600].entries()) {
      const conv = await conversation(`97150000100${i}`)
      await inbound(conv, 700)
      await run(
        `update conversations set first_response_at = now() - make_interval(mins => $2) where id = $1`,
        [conv, 700 - lag],
      )
    }
    const m = await getMetrics(run, OP, since())
    // Median of 2,3,4,600 minutes is 3.5 minutes — a mean would be over two hours.
    expect(m.firstResponseSeconds).toBeLessThan(300)
  })
})

describe('qualification', () => {
  it('counts an enquiry complete only with all three required fields', async () => {
    const conv = await conversation('971500000001')
    await inbound(conv)
    const enquiryId = (await ensureEnquiry(run, OP, conv))!
    const [msg] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body)
       values ($1,$2,'inbound','text','x') returning id`, [OP, conv],
    )
    for (const field of ['vehicle', 'start_at']) {
      await run(
        `insert into field_evidence (operator_id, enquiry_id, field, value, source_message_id,
                                     verification_state)
         values ($1,$2,$3::enquiry_field,'v',$4,'customer_stated')`,
        [OP, enquiryId, field, msg!['id']],
      )
    }
    expect((await getMetrics(run, OP, since())).qualifiedLeads).toBe(0)

    await run(
      `insert into field_evidence (operator_id, enquiry_id, field, value, source_message_id,
                                   verification_state)
       values ($1,$2,'delivery_preference','delivery',$3,'customer_stated')`,
      [OP, enquiryId, msg!['id']],
    )
    const m = await getMetrics(run, OP, since())
    expect(m.qualifiedLeads).toBe(1)
    expect(m.qualificationRate).toBe(1)
  })
})

describe('handoffs and time to a salesperson', () => {
  it('measures from raised to accepted', async () => {
    const conv = await conversation('971500000001')
    await inbound(conv)
    const { handoffId } = await raiseHandoff(run, {
      operatorId: OP, conversationId: conv, reason: 'customer_asked', summary: 'asked',
    })
    await run(`update handoffs set created_at = now() - interval '9 minutes' where id = $1`, [handoffId])
    await acceptHandoff(run, { handoffId: handoffId!, operatorId: OP, membershipId: SARA })

    const m = await getMetrics(run, OP, since())
    expect(m.handoffs).toBe(1)
    expect(m.timeToSalespersonSeconds).toBeGreaterThan(500)
  })

  it('counts a complaint separately from an ordinary handoff', async () => {
    const a = await conversation('971500000001')
    const b = await conversation('971500000002')
    const first = await raiseHandoff(run, { operatorId: OP, conversationId: a, reason: 'customer_asked', summary: 'x' })
    const second = await raiseHandoff(run, { operatorId: OP, conversationId: b, reason: 'safety_or_accident', summary: 'crash' })
    // Assert the fixture before the measure. A metrics test that fails because
    // the setup silently did nothing tells you the wrong thing.
    expect(first.handoffId).not.toBeNull()
    expect(second.handoffId).not.toBeNull()
    expect(await run(`select id from handoffs`, [])).toHaveLength(2)

    const m = await getMetrics(run, OP, since())
    expect(m).toMatchObject({ handoffs: 2, complaints: 1 })
  })
})

describe('outcomes', () => {
  it('counts wins and losses with their reasons', async () => {
    const won = await conversation('971500000001')
    const lost = await conversation('971500000002')
    const a = await closeLead(run, { operatorId: OP, conversationId: won, membershipId: SARA, outcome: 'won' })
    const b = await closeLead(run, {
      operatorId: OP, conversationId: lost, membershipId: SARA, outcome: 'lost', reason: 'price',
    })
    expect(a).toMatchObject({ closed: true })
    expect(b).toMatchObject({ closed: true })
    expect(await run(`select id from audit_events where action like 'lead.%'`, [])).toHaveLength(2)

    const m = await getMetrics(run, OP, since())
    expect(m).toMatchObject({ won: 1, lost: 1 })
    expect(m.lostReasons).toEqual([{ reason: 'price', count: 1 }])
  })

  /** A closed lead that keeps getting chased is the worst message this sends. */
  it('stops chasing a closed lead', async () => {
    const conv = await conversation('971500000001')
    await run(
      `insert into follow_ups (operator_id, conversation_id, reason, due_at)
       values ($1,$2,'awaiting_customer', now() + interval '1 hour')`,
      [OP, conv],
    )
    await closeLead(run, {
      operatorId: OP, conversationId: conv, membershipId: SARA, outcome: 'lost', reason: 'price',
    })
    const [row] = await run(`select state::text as state from follow_ups`, [])
    expect(row).toMatchObject({ state: 'cancelled' })
  })

  it('cannot be closed twice', async () => {
    const conv = await conversation('971500000001')
    await closeLead(run, { operatorId: OP, conversationId: conv, membershipId: SARA, outcome: 'won' })
    expect(await closeLead(run, {
      operatorId: OP, conversationId: conv, membershipId: SARA, outcome: 'lost', reason: 'price',
    })).toMatchObject({ closed: false })
  })
})

describe('incorrect answers', () => {
  /**
   * Nothing else in this system can detect one. Every safety mechanism prevents
   * a category of error; none notices a reply that is fluent, allowed and
   * untrue.
   */
  it('counts only what a person flagged', async () => {
    const conv = await conversation('971500000001')
    const [msg] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body)
       values ($1,$2,'outbound','text','We do not have a yellow Ferrari.') returning id`,
      [OP, conv],
    )
    expect((await getMetrics(run, OP, since())).incorrectAnswers).toBe(0)

    const result = await flagIncorrectAnswer(run, {
      operatorId: OP, messageId: msg!['id'] as string, membershipId: SARA,
      note: 'We do have one. It is in the fleet.',
    })
    expect(result).toMatchObject({ flagged: true })
    expect((await getMetrics(run, OP, since())).incorrectAnswers).toBe(1)
  })

  it('keeps the wording that was wrong, not just the count', async () => {
    const conv = await conversation('971500000001')
    const [msg] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body)
       values ($1,$2,'outbound','text','The deposit is AED 5,000.') returning id`, [OP, conv],
    )
    await flagIncorrectAnswer(run, {
      operatorId: OP, messageId: msg!['id'] as string, membershipId: SARA, note: 'Never published that',
    })
    const [audit] = await run(
      `select data from audit_events where action = 'answer.flagged_incorrect'`, [],
    )
    expect((audit!['data'] as Record<string, unknown>)['body']).toBe('The deposit is AED 5,000.')
  })

  it('cannot flag an inbound message', async () => {
    const conv = await conversation('971500000001')
    const [msg] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body)
       values ($1,$2,'inbound','text','hi') returning id`, [OP, conv],
    )
    expect(await flagIncorrectAnswer(run, {
      operatorId: OP, messageId: msg!['id'] as string, membershipId: SARA, note: 'x',
    })).toMatchObject({ flagged: false })
  })
})

describe('tenant isolation', () => {
  it('counts nothing from another operator', async () => {
    await inbound(await conversation('971500000001'))
    const other = await getMetrics(run, '22222222-2222-2222-2222-222222222222', since())
    expect(other.enquiries).toBe(0)
  })
})

describe('reading a duration', () => {
  it.each([
    [45, '45s'],
    [600, '10 min'],
    [7200, '2.0 h'],
    [null, '—'],
  ] as const)('%s reads as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})

/**
 * The reports knew about quotes and outcomes and nothing about bookings —
 * which were the newest thing in the product and the only one that commits a
 * car. An operator deciding whether to leave the agent confirming has exactly
 * one number to weigh, and it was not on the page.
 */
describe('what the bookings cost and earned', () => {
  let nth = 0

  const book = async (over: { discount?: number; automatic?: boolean } = {}) => {
    nth += 1
    // Counted rather than random: a phone collision silently loses a booking
    // and reads as the metric under-counting, which is a slow afternoon.
    const conv = await conversation(`9715500${String(nth).padStart(4, '0')}`)
    const [q] = await run(
      `insert into quotes (operator_id, conversation_id, revision, state, total_minor, lines,
                           discount_minor, approved_by_membership_id, approved_at)
       values ($1, $2, 1, 'sent', 500000, '[]'::jsonb, $3, $4, now())
       returning id`,
      [OP, conv, over.discount ?? null, SARA],
    )
    await run(
      `insert into bookings (operator_id, conversation_id, quote_id, state,
                             decided_automatically, decided_at)
       values ($1, $2, $3, 'confirmed', $4, now())`,
      [OP, conv, q!['id'], over.automatic === true],
    )
  }

  it('counts what was confirmed', async () => {
    await book()
    await book({ automatic: true })
    expect((await getMetrics(run, OP, since())).bookingsConfirmed).toBe(2)
  })

  /** The number an operator actually weighs: work that needed nobody. */
  it('separates the ones nobody was asked about', async () => {
    await book()
    await book({ automatic: true })
    await book({ automatic: true })
    expect((await getMetrics(run, OP, since())).confirmedByAgent).toBe(2)
  })

  it('adds up what was given away', async () => {
    await book({ discount: 50_000 })
    await book({ discount: 25_000 })
    await book()
    expect((await getMetrics(run, OP, since())).discountedMinor).toBe(75_000)
  })

  it('is zero rather than absent when nothing happened', async () => {
    expect(await getMetrics(run, OP, since())).toMatchObject({
      bookingsConfirmed: 0, confirmedByAgent: 0, discountedMinor: 0,
    })
  })
})
