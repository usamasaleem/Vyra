import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  advanceStage, ensureEnquiry, getEnquiryFields, getFieldHistory, missingFields,
  outstandingQuestions, recordAsked, recordFields, stageFromEvidence,
} from '../src/queries/enquiry-fields.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let enquiryId: string
let messageId: string

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
    insert into operators (id, name) values ('${OP}', 'Vyra Pilot'), ('${RIVAL}', 'Rival');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333');
  `)
  const m = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', 'Ferrari from Friday', 'wamid.1') returning id`, [OP, CONV])
  messageId = m[0]!.id as string
  enquiryId = (await ensureEnquiry(run, OP, CONV))!
})

describe('creating the enquiry', () => {
  it('creates one for a conversation and reuses it', async () => {
    expect(enquiryId).toBeTruthy()
    expect(await ensureEnquiry(run, OP, CONV)).toBe(enquiryId)
  })

  it('refuses another operator conversation', async () => {
    expect(await ensureEnquiry(run, RIVAL, CONV)).toBeNull()
  })
})

describe('recording what the customer said', () => {
  it('stores the value with its source message and original wording', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [{
        field: 'start_at', value: '2026-09-18T00:00:00.000Z',
        originalWording: 'Friday', sourceMessageId: messageId,
      }],
    })

    const fields = await getEnquiryFields(run, OP, enquiryId)
    expect(fields[0]).toMatchObject({
      field: 'start_at',
      value: '2026-09-18T00:00:00.000Z',
      originalWording: 'Friday',
      sourceMessageId: messageId,
      verificationState: 'customer_stated',
    })
  })

  it('records several fields at once', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari' },
        { field: 'duration', value: '3 days' },
        { field: 'location', value: 'Dubai Marina' },
      ],
    })
    expect((await getEnquiryFields(run, OP, enquiryId)).map((f) => f.field).sort())
      .toEqual(['duration', 'location', 'vehicle'])
  })

  it('does not treat a restated value as a correction', async () => {
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'vehicle', value: 'Ferrari' }] })
    const again = await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'vehicle', value: 'Ferrari' }] })

    expect(again[0]).toMatchObject({ corrected: false })
    expect(await getFieldHistory(run, OP, enquiryId, 'vehicle')).toHaveLength(1)
  })
})

describe('when the customer changes their mind', () => {
  /** Section 15: summarise the conflict, do not silently overwrite. */
  it('supersedes rather than overwrites, and says it was a correction', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [{ field: 'start_at', value: '2026-09-18', originalWording: 'Friday' }],
    })
    const result = await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [{ field: 'start_at', value: '2026-09-19', originalWording: 'actually Saturday' }],
    })

    expect(result[0]).toMatchObject({
      corrected: true, previousValue: '2026-09-18', value: '2026-09-19',
    })
  })

  it('keeps both statements, so the conflict can be explained', async () => {
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'start_at', value: '2026-09-18', originalWording: 'Friday' }] })
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'start_at', value: '2026-09-19', originalWording: 'actually Saturday' }] })

    const history = await getFieldHistory(run, OP, enquiryId, 'start_at')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ value: '2026-09-19', superseded: false })
    expect(history[1]).toMatchObject({ value: '2026-09-18', originalWording: 'Friday', superseded: true })
  })

  it('marks the superseded value as conflicting rather than deleting it', async () => {
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'start_at', value: '2026-09-18' }] })
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'start_at', value: '2026-09-19' }] })

    const rows = await run(
      `select value, verification_state::text as state from field_evidence where superseded_at is not null`, [])
    expect(rows[0]).toMatchObject({ value: '2026-09-18', state: 'conflicting' })
  })

  it('leaves exactly one live value', async () => {
    for (const v of ['2026-09-18', '2026-09-19', '2026-09-20']) {
      await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'start_at', value: v }] })
    }
    const live = await getEnquiryFields(run, OP, enquiryId)
    expect(live.filter((f) => f.field === 'start_at')).toHaveLength(1)
    expect(live.find((f) => f.field === 'start_at')!.value).toBe('2026-09-20')
    expect(await getFieldHistory(run, OP, enquiryId, 'start_at')).toHaveLength(3)
  })
})

describe('knowing what is still missing', () => {
  it('reports everything required when nothing has been said', async () => {
    expect((await missingFields(run, OP, enquiryId)).sort())
      .toEqual(['delivery_preference', 'end_at', 'start_at', 'vehicle'])
  })

  it('accepts a duration in place of an end date', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari' },
        { field: 'start_at', value: '2026-09-18' },
        { field: 'duration', value: '3 days' },
        { field: 'delivery_preference', value: 'delivery' },
      ],
    })
    expect(await missingFields(run, OP, enquiryId)).toEqual([])
  })

  it('still wants a delivery preference when only dates are known', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari' },
        { field: 'start_at', value: '2026-09-18' },
        { field: 'end_at', value: '2026-09-21' },
      ],
    })
    expect(await missingFields(run, OP, enquiryId)).toEqual(['delivery_preference'])
  })
})

describe('isolation', () => {
  it('does not return another operator fields', async () => {
    await recordFields(transact, { operatorId: OP, enquiryId, observations: [{ field: 'vehicle', value: 'Ferrari' }] })
    expect(await getEnquiryFields(run, RIVAL, enquiryId)).toEqual([])
  })
})

/**
 * The stage an enquiry has plainly reached.
 *
 * Nothing advanced it before. The only code that wrote sales_stage was the
 * manual won/lost close-out, so a conversation ninety-four messages deep with
 * a named car, confirmed dates, a calculated quote and an escalated discount
 * was still sitting at 'new' — which made the qualification rate on the
 * reports page structurally zero.
 */
describe('stageFromEvidence', () => {
  const fields = (...names: string[]) => names.map((field) => ({ field }))

  it('is new with nothing on file', () => {
    expect(stageFromEvidence({ fields: [], quoteSent: false, optionsSent: false })).toBe('new')
  })

  it('is qualifying once anything has been established', () => {
    expect(stageFromEvidence({ fields: fields('vehicle'), quoteSent: false, optionsSent: false }))
      .toBe('qualifying')
  })

  /** Section 3 lists the fields. Either they are recorded or they are not. */
  it('is qualified once the required fields are there', () => {
    expect(stageFromEvidence({
      fields: fields('vehicle', 'start_at', 'delivery_preference'),
      quoteSent: false, optionsSent: false,
    })).toBe('qualified')
  })

  it('is quote_sent once a quote has been prepared', () => {
    expect(stageFromEvidence({ fields: fields('vehicle'), quoteSent: true, optionsSent: true }))
      .toBe('quote_sent')
  })
})

describe('advanceStage', () => {
  const stageOf = async () =>
    (await run(`select sales_stage::text as s from conversations where id = $1`, [CONV]))[0]!['s']

  it('moves a conversation forward', async () => {
    expect(await advanceStage(run, { operatorId: OP, conversationId: CONV, stage: 'qualified' }))
      .toMatchObject({ moved: true })
    expect(await stageOf()).toBe('qualified')
  })

  /** A later message that establishes less has not undone what was established. */
  it('never moves it backwards', async () => {
    await advanceStage(run, { operatorId: OP, conversationId: CONV, stage: 'quote_sent' })
    await advanceStage(run, { operatorId: OP, conversationId: CONV, stage: 'qualifying' })

    expect(await stageOf()).toBe('quote_sent')
  })

  /**
   * Won and lost are somebody's decision. A customer who writes again after
   * being marked lost is a person reopening a lead, not a row to rewrite.
   */
  it.each(['won', 'lost'])('leaves %s alone', async (decided) => {
    await run(`update conversations set sales_stage = $2::sales_stage where id = $1`, [CONV, decided])

    expect(await advanceStage(run, { operatorId: OP, conversationId: CONV, stage: 'quote_sent' }))
      .toMatchObject({ moved: false })
    expect(await stageOf()).toBe(decided)
  })

  it('leaves another operator conversation alone', async () => {
    expect(await advanceStage(run, {
      operatorId: '99999999-9999-9999-9999-999999999999',
      conversationId: CONV, stage: 'qualified',
    })).toMatchObject({ moved: false })
  })
})

/**
 * What the agent still needs, and when it may ask again.
 *
 * missingFields has existed since step 21 and was read in exactly one place:
 * the handoff packet, which tells a person what is missing after the
 * conversation has already been given away. The agent itself was never told,
 * and it showed — it asked for dates once, the customer asked four questions
 * of their own instead, and it answered all four and never came back.
 */
describe('outstandingQuestions', () => {
  const ask = (fields: readonly string[]) =>
    recordAsked(run, {
      operatorId: OP, conversationId: CONV, fields: fields as never,
    })

  const outstanding = async () =>
    (await outstandingQuestions(run, { operatorId: OP, conversationId: CONV, enquiryId }))
      .map((q) => q.field)

  const bumpRevision = (by: number) =>
    run(`update conversations set revision = revision + $2 where id = $1`, [CONV, by])

  it('names what the enquiry is missing', async () => {
    expect(await outstanding()).toContain('start_at')
  })

  it('says nothing once everything required is recorded', async () => {
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari 488' },
        { field: 'start_at', value: '2026-09-25' },
        { field: 'end_at', value: '2026-09-28' },
        { field: 'delivery_preference', value: 'delivery' },
      ],
    })
    expect(await outstanding()).toEqual([])
  })

  /** Asking twice in a row is a form. */
  it('will not ask the same thing on the next turn', async () => {
    await ask(['start_at'])
    expect(await outstanding()).not.toContain('start_at')
  })

  it('comes back to it a few turns later', async () => {
    await ask(['start_at'])
    await bumpRevision(3)
    expect(await outstanding()).toContain('start_at')
  })

  /**
   * The whole design. A salesperson asks again; a form asks until somebody
   * stops replying, and the difference is entirely this number.
   */
  it('lets it go after twice', async () => {
    await ask(['start_at'])
    await bumpRevision(3)
    await ask(['start_at'])
    await bumpRevision(3)

    expect(await outstanding()).not.toContain('start_at')
  })

  /** Asking about one thing does not silence the others. */
  it('still asks about the rest', async () => {
    await ask(['start_at'])
    expect(await outstanding()).toContain('delivery_preference')
  })

  it('leaves another operator conversation alone', async () => {
    await recordAsked(run, {
      operatorId: RIVAL, conversationId: CONV, fields: ['start_at'] as never,
    })
    expect(await outstanding()).toContain('start_at')
  })
})
