import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createToolBoundary } from '../src/tools/boundary.ts'
import type { ToolContext } from '../src/tools/context.ts'
import { toolDefinitions, TOOL_NAMES } from '../src/tools/schemas.ts'
import { draftKnowledge, publishKnowledge } from '../../db/src/queries/knowledge.ts'
import { ensureEnquiry } from '../../db/src/queries/enquiry-fields.ts'
import { queueOutboundText } from '../../db/src/queries/outbound.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const RIVAL_MEMBER = '44444444-4444-4444-4444-4444444444aa'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const TZ = 'Asia/Dubai'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let ctx: ToolContext

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
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', '${TZ}'), ('${RIVAL}', 'Rival', '${TZ}');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role) values
      ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson'),
      ('${RIVAL_MEMBER}', '${RIVAL}', '10000000-0000-0000-0000-000000000002', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const m = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', 'Ferrari from Friday', 'wamid.1') returning id`,
    [OP, CONV],
  )
  ctx = {
    operatorId: OP,
    conversationId: CONV,
    enquiryId: (await ensureEnquiry(run, OP, CONV))!,
    messageId: m[0]!['id'] as string,
    timezone: TZ,
    now: new Date('2026-09-14T08:00:00Z'),
    run,
    transact,
  }
})

async function publish(operatorId: string, topic: string, answer: string) {
  const draft = await draftKnowledge(run, { operatorId, topic, answer, confirmedBy: 'Owner' })
  const result = await publishKnowledge(transact, {
    operatorId, entryId: draft.id, membershipId: operatorId === OP ? MEMBER : RIVAL_MEMBER,
  })
  // Assert the fixture actually published. A silently unpublished answer would
  // make every test below pass for the wrong reason.
  expect(result.published).toBe(true)

  /**
   * Backdate it before the pinned eval clock.
   *
   * publishKnowledge stamps effective_from from the database clock, and ctx.now
   * is fixed at 08:00 so date handling is deterministic. Left alone, the answer
   * becomes effective after the moment the test pretends it is, and
   * getApprovedAnswer correctly finds nothing — so this passed every morning
   * and failed every afternoon.
   */
  await run(
    `update knowledge_entries set effective_from = $2 where id = $1`,
    [draft.id, new Date('2026-09-13T00:00:00Z').toISOString()],
  )
}

describe('the shape of the boundary', () => {
  it('exposes exactly the six tools in the specification', () => {
    expect(TOOL_NAMES).toEqual([
      'get_operator_policy', 'search_vehicles', 'prepare_quote',
      'record_enquiry_fields', 'request_handoff', 'request_booking_review',
    ])
  })

  /**
   * The tenancy claim, asserted rather than assumed. If an operator id ever
   * becomes a tool argument, a model can name another operator, and every
   * scope check in the system moves from structural to remembered.
   */
  it('gives the model no way to name an operator', () => {
    const serialised = JSON.stringify(toolDefinitions())
    expect(serialised).not.toMatch(/operator_?[Ii]d/)
  })

  /** Section 18.8 [T7]: no additional properties, and every property required. */
  it('emits strict schemas', () => {
    for (const tool of toolDefinitions()) {
      const params = tool.parameters as { additionalProperties?: unknown; properties?: object; required?: string[] }
      expect(params.additionalProperties, tool.name).toBe(false)
      expect(params.required?.slice().sort(), tool.name).toEqual(Object.keys(params.properties ?? {}).sort())
    }
  })

  it('has no discount argument anywhere', () => {
    expect(JSON.stringify(toolDefinitions())).not.toMatch(/discount/i)
  })

  it.each(['issue_refund', 'confirm_booking', 'run_sql', 'fetch_url', 'verify_payment'])(
    'refuses %s rather than failing obscurely',
    async (name) => {
      const result = await createToolBoundary(ctx).call(name, {})
      expect(result).toMatchObject({ status: 'refused', reason: 'unknown_tool' })
    },
  )
})

describe('get_operator_policy', () => {
  it('refuses when the operator has not published an answer', async () => {
    const result = await createToolBoundary(ctx).call('get_operator_policy', { topic: 'deposit' })
    expect(result).toMatchObject({ status: 'refused', reason: 'no_approved_answer' })
  })

  it('returns the answer with the version that produced it', async () => {
    await publish(OP, 'deposit', 'AED 5,000, refunded within 14 days.')
    const result = await createToolBoundary(ctx).call('get_operator_policy', { topic: 'deposit' })
    expect(result).toMatchObject({
      status: 'ok',
      data: { answer: 'AED 5,000, refunded within 14 days.', version: 1, confirmedBy: 'Owner' },
    })
  })

  /** The scope check that cannot be forgotten, because there is no argument for it. */
  it('cannot reach another operator\'s published answer', async () => {
    await publish(RIVAL, 'deposit', 'AED 1,000 — the rival undercuts on deposit.')
    const result = await createToolBoundary(ctx).call('get_operator_policy', { topic: 'deposit' })
    expect(result).toMatchObject({ status: 'refused', reason: 'no_approved_answer' })
  })

  it('refuses a topic that is not in the closed list', async () => {
    const result = await createToolBoundary(ctx).call('get_operator_policy', { topic: 'depsoit' })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })

  it('does not return an unpublished draft', async () => {
    await draftKnowledge(run, {
      operatorId: OP, topic: 'deposit', answer: 'Draft — not approved by the owner yet.',
      confirmedBy: 'Owner',
    })
    const result = await createToolBoundary(ctx).call('get_operator_policy', { topic: 'deposit' })
    expect(result).toMatchObject({ status: 'refused', reason: 'no_approved_answer' })
  })
})

describe('search_vehicles', () => {
  it('refuses a start date already in the past for the operator', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: '2026-09-01', endDate: '2026-09-05',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
    expect((result as { detail: string }).detail).toContain('2026-09-14')
  })

  it('refuses an end date before the start', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: '2026-09-20', endDate: '2026-09-18',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })

  it('refuses a date that is well-formed but not real', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: '2026-02-31', endDate: null,
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })

  it('will not check availability without a start date', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: null, endDate: null,
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })

  /**
   * The one that matters. Valid dates, a real vehicle, and still no answer —
   * because there is no verified source, and inventing availability is the
   * failure this boundary exists to prevent.
   */
  it('refuses to answer with no verified inventory source, even when the request is perfect', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari 488', startDate: '2026-09-20', endDate: '2026-09-23',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'no_trusted_source' })
  })
})

describe('search_vehicles with a fleet', () => {
  async function addVehicle(overrides: Record<string, unknown> = {}) {
    const v = {
      make: 'Ferrari', model: '488', variant: 'Spider', year: 2022,
      colour: 'Giallo Modena (yellow)', category: 'exotic',
      plate: 'Dubai K 20933', chassis: 'ZFF80AMA9N0273641',
      provenance: 'operator_confirmed', operator: OP, active: true, ...overrides,
    }
    await run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category,
                             plate, chassis_number, engine, power_hp, seats, doors,
                             active, provenance, confirmed_by)
       values ($1,$2,$3,$4,$5,$6,$7::vehicle_category,$8,$9,'3.9 L twin-turbo V8',661,2,2,
               $10,$11::fleet_provenance,'Owner')`,
      [v.operator, v.make, v.model, v.variant, v.year, v.colour, v.category,
       v.plate, v.chassis, v.active, v.provenance],
    )
  }

  const search = (vehicle: string | null) =>
    createToolBoundary(ctx).call('search_vehicles', {
      vehicle, startDate: '2026-09-20', endDate: '2026-09-23',
    })

  it('describes the car, and refuses to say it is available', async () => {
    await addVehicle()
    const result = await search('ferrari')
    expect(result).toMatchObject({
      status: 'ok',
      data: {
        availabilityChecked: false,
        fleet: [{ make: 'Ferrari', model: '488', colour: 'Giallo Modena (yellow)', powerHp: 661 }],
      },
    })
    const detail = JSON.stringify(result)
    expect(detail).toContain('NOT say any of them is available')
  })

  /** The model has no use for an identifier and every opportunity to misuse one. */
  it('never hands the model a plate or a chassis number', async () => {
    await addVehicle()
    const result = JSON.stringify(await search('ferrari'))
    expect(result).not.toContain('Dubai K 20933')
    expect(result).not.toContain('ZFF80AMA9N0273641')
  })

  /**
   * The fleet equivalent of the unpublished knowledge rule. A car nobody has
   * confirmed exists is a car the agent must not describe.
   */
  it('does not return a car whose provenance is still placeholder', async () => {
    await addVehicle({ provenance: 'placeholder' })
    const result = await search('ferrari')
    expect(result).toMatchObject({ status: 'refused', reason: 'no_trusted_source' })
  })

  it('does not return a car that is off the road', async () => {
    await addVehicle()
    await addVehicle({ make: 'Lamborghini', model: 'Huracán', plate: 'Dubai P 41785',
                       chassis: 'ZHWUT4ZF0PLA14872', active: false })
    const result = await search('lamborghini')
    expect(result).toMatchObject({ status: 'ok', data: { fleet: [] } })
  })

  it('tells the model to say so rather than invent, when nothing matches', async () => {
    await addVehicle()
    const result = await search('bugatti')
    expect(result).toMatchObject({ status: 'ok', data: { fleet: [] } })
    expect(JSON.stringify(result)).toContain('do not invent a car')
  })

  it('still refuses a date in the past before it looks at the fleet', async () => {
    await addVehicle()
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'ferrari', startDate: '2026-09-01', endDate: null,
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })
})

describe('prepare_quote', () => {
  it('refuses an enquiry that is not the one being discussed', async () => {
    const result = await createToolBoundary(ctx).call('prepare_quote', {
      enquiryId: '99999999-9999-9999-9999-999999999999',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'wrong_scope' })
  })

  it('refuses to calculate without approved rates', async () => {
    const result = await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })
    expect(result).toMatchObject({ status: 'refused', reason: 'not_available_yet' })
  })
})

describe('record_enquiry_fields', () => {
  it('attaches the message the customer actually sent as evidence', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', {
      fields: [{ field: 'vehicle', value: 'Ferrari 488', originalWording: 'the red ferrari' }],
    })
    expect(result).toMatchObject({ status: 'ok' })

    const rows = await run(
      `select source_message_id, verification_state::text as state, original_wording
       from field_evidence where enquiry_id = $1 and field = 'vehicle'`,
      [ctx.enquiryId],
    )
    expect(rows[0]).toMatchObject({
      source_message_id: ctx.messageId,
      state: 'customer_stated',
      original_wording: 'the red ferrari',
    })
  })

  it('reports a correction as a conflict instead of overwriting silently', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('record_enquiry_fields', { fields: [{ field: 'start_at', value: '2026-09-18', originalWording: 'Friday' }] })
    const second = await boundary.call('record_enquiry_fields', {
      fields: [{ field: 'start_at', value: '2026-09-19', originalWording: 'actually Saturday' }],
    })

    expect(second).toMatchObject({
      status: 'ok',
      data: { conflicts: [{ field: 'start_at', previousValue: '2026-09-18', newValue: '2026-09-19' }] },
    })

    // Both are still on record — Friday is still answerable on Monday.
    const history = await run(
      `select value from field_evidence where enquiry_id = $1 and field = 'start_at' order by extracted_at`,
      [ctx.enquiryId],
    )
    expect(history.map((r) => r['value'])).toEqual(['2026-09-18', '2026-09-19'])
  })

  it('does not treat a customer repeating themselves as a correction', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('record_enquiry_fields', { fields: [{ field: 'vehicle', value: 'Ferrari 488', originalWording: null }] })
    const again = await boundary.call('record_enquiry_fields', {
      fields: [{ field: 'vehicle', value: 'Ferrari 488', originalWording: null }],
    })
    expect(again).toMatchObject({ status: 'ok', data: { conflicts: [] } })
  })

  it('refuses to record an unresolved date as a fact', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', {
      fields: [{ field: 'start_at', value: 'next Friday', originalWording: 'next friday' }],
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })

    const rows = await run(`select 1 from field_evidence where enquiry_id = $1`, [ctx.enquiryId])
    expect(rows).toHaveLength(0)
  })

  it('refuses a field that is not part of an enquiry', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', {
      fields: [{ field: 'credit_card', value: '4111111111111111', originalWording: null }],
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })
})

describe('request_handoff', () => {
  it('pauses sending and cancels the AI draft already queued', async () => {
    const draft = await queueOutboundText(run, {
      conversationId: CONV, operatorId: OP, body: 'Our deposit is usually around AED 5,000.',
      idempotencyKey: 'turn:1',
    })

    const result = await createToolBoundary(ctx).call('request_handoff', {
      reason: 'Customer says the car was damaged when it arrived.',
    })
    expect(result).toMatchObject({ status: 'ok', data: { paused: true, cancelledDrafts: 1 } })

    const [message] = await run(
      `select delivery_state::text as state, error_code from messages where id = $1`,
      [draft.messageId],
    )
    expect(message).toMatchObject({ state: 'cancelled', error_code: 'handoff_requested' })

    const [conversation] = await run(
      `select handler_mode::text as mode, next_action, revision from conversations where id = $1`,
      [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'human', revision: 1 })
    expect(conversation!['next_action']).toContain('damaged')
  })

  it('is idempotent — asking twice does not bump the revision twice', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('request_handoff', { reason: 'Customer asked for a person.' })
    const second = await boundary.call('request_handoff', { reason: 'Customer asked again.' })

    expect(second).toMatchObject({ status: 'ok', data: { paused: false, alreadyWithAPerson: true } })

    const [conversation] = await run(`select revision from conversations where id = $1`, [CONV])
    expect(conversation).toMatchObject({ revision: 1 })

    const audits = await run(
      `select id from audit_events where subject_id = $1 and action = 'conversation.handoff_requested'`,
      [CONV],
    )
    expect(audits).toHaveLength(1)
  })

  it('leaves a salesperson\'s own queued message alone', async () => {
    const staff = await queueOutboundText(run, {
      conversationId: CONV, operatorId: OP, body: 'Sara here — one moment.',
      idempotencyKey: 'staff:1', sentByMembershipId: MEMBER,
    })
    await createToolBoundary(ctx).call('request_handoff', { reason: 'Complaint.' })

    const [message] = await run(`select delivery_state::text as state from messages where id = $1`, [staff.messageId])
    expect(message).toMatchObject({ state: 'pending' })
  })

  it('refuses a conversation belonging to another operator', async () => {
    const strayed = createToolBoundary({ ...ctx, operatorId: RIVAL })
    const result = await strayed.call('request_handoff', { reason: 'Complaint.' })
    expect(result).toMatchObject({ status: 'refused', reason: 'wrong_scope' })

    const [conversation] = await run(`select handler_mode::text as mode from conversations where id = $1`, [CONV])
    expect(conversation).toMatchObject({ mode: 'ai' })
  })

  it('records the AI as the actor, not a person', async () => {
    await createToolBoundary(ctx).call('request_handoff', { reason: 'Legal threat.' })
    const [audit] = await run(
      `select actor_type::text as actor, actor_id from audit_events where subject_id = $1`,
      [CONV],
    )
    expect(audit).toMatchObject({ actor: 'ai', actor_id: null })
  })
})

describe('request_booking_review', () => {
  it('refuses, because confirming a booking is not a model decision', async () => {
    const result = await createToolBoundary(ctx).call('request_booking_review', {
      quoteId: '99999999-9999-9999-9999-999999999999',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'not_available_yet' })
  })
})

describe('the budget', () => {
  it('stops a model looping on a refusal', async () => {
    const boundary = createToolBoundary(ctx, { maxCalls: 3 })
    for (let i = 0; i < 3; i++) {
      const r = await boundary.call('get_operator_policy', { topic: 'deposit' })
      expect(r).toMatchObject({ reason: 'no_approved_answer' })
    }
    expect(boundary.callsRemaining()).toBe(0)
    expect(await boundary.call('get_operator_policy', { topic: 'deposit' }))
      .toMatchObject({ status: 'refused', reason: 'budget_exhausted' })
  })

  it('cannot be extended by asking for tools that do not exist', async () => {
    const boundary = createToolBoundary(ctx, { maxCalls: 2 })
    await boundary.call('issue_refund', {})
    await boundary.call('issue_refund', {})
    expect(await boundary.call('request_handoff', { reason: 'Customer asked for a person.' }))
      .toMatchObject({ status: 'refused', reason: 'budget_exhausted' })
  })

  it('stops when the turn runs out of time', async () => {
    let t = 1_000
    const boundary = createToolBoundary(ctx, {
      deadline: new Date(5_000),
      clock: () => t,
    })
    expect(await boundary.call('get_operator_policy', { topic: 'deposit' })).toMatchObject({ status: 'refused', reason: 'no_approved_answer' })
    t = 6_000
    expect(await boundary.call('get_operator_policy', { topic: 'deposit' })).toMatchObject({ status: 'refused', reason: 'budget_exhausted' })
  })

  it('records every attempt, including the refused ones', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('issue_refund', {})
    await boundary.call('get_operator_policy', { topic: 'deposit' })
    await boundary.call('request_handoff', { reason: 'Customer asked for a person.' })

    expect(boundary.history.map((h) => [h.requestedName, h.status, h.reason])).toEqual([
      ['issue_refund', 'refused', 'unknown_tool'],
      ['get_operator_policy', 'refused', 'no_approved_answer'],
      ['request_handoff', 'ok', null],
    ])
  })
})

describe('infrastructure failure', () => {
  /**
   * A database that is down is not a refusal. Disguising it as one would let a
   * turn continue as though the answer were simply unavailable, and the model
   * would tell the customer something reassuring about a system that is broken.
   */
  it('propagates rather than reporting a refusal', async () => {
    const broken: ToolContext = {
      ...ctx,
      run: async () => { throw new Error('connection terminated unexpectedly') },
    }
    const boundary = createToolBoundary(broken)
    await expect(boundary.call('get_operator_policy', { topic: 'deposit' })).rejects.toThrow(/connection terminated/)
    expect(boundary.history).toHaveLength(1)
  })
})
