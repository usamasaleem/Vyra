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
    insert into memberships (id, operator_id, user_id, role, display_name) values
      ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson', 'Ahmed'),
      ('${RIVAL_MEMBER}', '${RIVAL}', '10000000-0000-0000-0000-000000000002', 'salesperson', 'Omar');
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
  const membershipId = operatorId === OP ? MEMBER : RIVAL_MEMBER
  const draft = await draftKnowledge(run, {
    operatorId, topic, answer, confirmedBy: 'Owner', confirmedByMembershipId: membershipId,
  })
  const result = await publishKnowledge(transact, { operatorId, entryId: draft.id, membershipId })
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
  /**
   * The list is asserted whole so that adding a tool is a deliberate edit to
   * this test rather than something that happens quietly. Six were the
   * specification's; extend_booking is the seventh and the first added since,
   * because keeping the car longer is the thing customers ask for most once
   * they have it and the agent could do nothing about it.
   */
  it('exposes exactly the tools it is meant to', () => {
    expect(TOOL_NAMES).toEqual([
      'get_operator_policy', 'search_vehicles', 'prepare_quote',
      'record_enquiry_fields', 'request_handoff', 'request_booking_review',
      'extend_booking',
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
      vehicle: 'Ferrari', startDate: '2026-09-01', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-09-05',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
    expect((result as { detail: string }).detail).toContain('2026-09-14')
  })

  it('refuses an end date before the start', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: '2026-09-20', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-09-18',
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
  })

  it('refuses a date that is well-formed but not real', async () => {
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: '2026-02-31', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: null,
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
      vehicle: 'Ferrari 488', startDate: '2026-09-20', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-09-23',
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
      vehicle, startDate: '2026-09-20', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-09-23',
    })

  const rate = (dailyMinor: number, vehicleMatch: string) =>
    run(
      `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                                  minimum_days, provenance, confirmed_by, confirmed_at)
       select $1, id, 'AED', $2, 1, 'operator_confirmed', 'Owner', now() from vehicles
       where operator_id = $1 and model = $3`,
      [OP, dailyMinor, vehicleMatch],
    )

  /**
   * Without dates the fleet still comes back and the availability does not.
   *
   * This used to refuse outright, and live that meant a customer asking "what
   * is your most expensive car" received nothing — not even the car list — so
   * the agent fell back on "I'll check with the team" about cars sitting
   * confirmed in the database. Dates are what availability needs; they were
   * never what the fleet needed.
   */
  it('returns the fleet without dates, and refuses only the availability', async () => {
    await addVehicle()
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'Ferrari', startDate: null, category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: null,
    })

    expect(result).toMatchObject({ status: 'ok' })
    const data = (result as {
      data: { fleet: unknown[]; availability?: unknown; guidance: string }
    }).data
    expect(data.fleet.length).toBe(1)
    expect(data.availability).toBeUndefined()
    expect(data.guidance).toContain('do not say available')
  })

  it('carries the confirmed day rate, formatted, and null when none is set', async () => {
    await addVehicle()
    await addVehicle({ make: 'Rolls-Royce', model: 'Cullinan', variant: null,
                       colour: 'English White', plate: 'Dubai A 1', chassis: 'VIN-RR' })
    await rate(800_000, 'Cullinan')

    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: null, startDate: null, category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: null,
    })
    const { fleet } = (result as { data: { fleet: Array<{ model: string; dayRate: string | null }> } }).data

    // Dearest first, so "the most expensive car" is the first row rather than a
    // comparison the model performs.
    expect(fleet[0]).toMatchObject({ model: 'Cullinan', dayRate: 'AED 8,000' })
    // The unpriced car says so. A null here must never be read as free, and
    // must never be filled in from the car above it.
    expect(fleet[1]).toMatchObject({ model: '488', dayRate: null })
  })

  it('describes the car, and refuses to say it is available until someone checks', async () => {
    await addVehicle()
    const result = await search('ferrari')
    expect(result).toMatchObject({
      status: 'ok',
      data: { fleet: [{ make: 'Ferrari', model: '488', colour: 'Giallo Modena (yellow)', powerHp: 661 }] },
    })
    // No availability field at all: absent means nobody looked, which is not
    // the same as "no" and must not be representable as one.
    expect((result as { data: { availability?: unknown } }).data.availability).toBeUndefined()
    expect(JSON.stringify(result)).toContain('may NOT say available')
  })

  /**
   * Section 6: the agent sends a structured request to the Operations queue. An
   * availability question that produces no request is a customer told "I'll
   * check" by a system that will not.
   */
  it('puts the question in front of Operations', async () => {
    await addVehicle()
    await search('ferrari')

    const [request] = await run(
      `select kind::text as kind, state::text as state, start_date, end_date,
              requested_vehicle, checked_at
       from operations_requests where operator_id = $1`, [OP],
    )
    expect(request).toMatchObject({
      kind: 'availability', state: 'open', requested_vehicle: 'ferrari',
    })
    // Never defaulted. A row nobody has looked at must not claim a check time.
    expect(request!['checked_at']).toBeNull()
  })

  it('asks once, however many customers ask the same thing', async () => {
    await addVehicle()
    await search('ferrari')
    await search('488')
    const rows = await run(`select id from operations_requests where operator_id = $1`, [OP])
    expect(rows).toHaveLength(1)
  })

  /** The model has no use for an identifier and every opportunity to misuse one. */
  /**
   * Regression. The first version matched the query as one substring per
   * column, so "yellow Ferrari" found nothing — make is 'Ferrari', colour is
   * 'Giallo Modena (yellow)', and neither holds the phrase. A customer was told
   * "we don't have a yellow Ferrari" about a car in the fleet: a false
   * statement produced by a correct tool result.
   */
  it.each([
    'yellow ferrari',
    'ferrari yellow',
    'a yellow Ferrari',
    'Giallo Ferrari',
    '488',
    'yellow 488 spider',
    'exotic',
  ])('finds the car from "%s"', async (query) => {
    await addVehicle()
    const result = await search(query)
    expect(result).toMatchObject({ status: 'ok' })
    expect((result as { data: { fleet: unknown[] } }).data.fleet).toHaveLength(1)
  })

  /**
   * Regression, and a live one. A customer asked for a "Huracan"; the fleet
   * holds "Huracán"; ilike matched nothing and the agent replied that we did
   * not have that car. It was there, with a confirmed rate.
   *
   * Nobody types the accent. Both directions are covered because the fleet may
   * hold either spelling.
   */
  it.each([
    ['Huracan', 'Huracán'],
    ['Huracán', 'Huracan'],
    ['huracan evo', 'Huracán'],
    ['lamborghini huracan', 'Huracán'],
  ])('finds %j when the fleet says %j', async (query, stored) => {
    await addVehicle({
      make: 'Lamborghini', model: stored, variant: 'EVO Spyder',
      colour: 'Arancio Borealis (orange)', plate: 'Dubai B 2', chassis: 'VIN-LB',
    })
    const result = await search(query)
    expect(result).toMatchObject({ status: 'ok' })
    expect((result as { data: { fleet: unknown[] } }).data.fleet).toHaveLength(1)
  })

  /**
   * The word filter still refuses to over-match: a yellow Ferrari is not a red
   * one. What changed is what happens next — the tool says the words matched
   * nothing and shows what the operator actually has, rather than asserting the
   * car does not exist. Deciding whether one of them is what the customer meant
   * is the model's job, and it is better at it than a LIKE.
   */
  it.each(['yellow lamborghini', 'red ferrari', 'ferrari convertible saloon'])(
    'does not pretend "%s" matched something',
    async (query) => {
      await addVehicle()
      const result = await search(query)
      expect(result).toMatchObject({ status: 'ok' })
      expect((result as { data: { guidance: string } }).data.guidance)
        .toContain('did not match anything')
    },
  )

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

  /**
   * The safety property, restated for the catalogue.
   *
   * A search that matches nothing now returns the operator's whole fleet so the
   * model can decide what the customer meant. An off-road car must not appear
   * in that list either — the guarantee is about which cars exist to be
   * mentioned, not about how the list was narrowed.
   */
  it('never shows a car that is off the road, even in the whole-fleet fallback', async () => {
    await addVehicle()
    await addVehicle({ make: 'Lamborghini', model: 'Huracán', plate: 'Dubai P 41785',
                       chassis: 'ZHWUT4ZF0PLA14872', active: false })

    const result = await search('lamborghini')
    const { fleet } = (result as { data: { fleet: Array<{ make: string }> } }).data
    expect(fleet.map((v) => v.make)).not.toContain('Lamborghini')
  })

  /**
   * Nothing matched the words, so the model is handed the fleet instead of a
   * verdict. It must still not invent: what it sees is exactly what exists.
   */
  it('shows the whole fleet rather than claiming the car does not exist', async () => {
    await addVehicle()
    const result = await search('bugatti')

    const data = (result as { data: { fleet: Array<{ make: string }>; guidance: string } }).data
    expect(data.fleet.map((v) => v.make)).toEqual(['Ferrari'])
    expect(data.guidance).toContain('ENTIRE fleet')
    expect(data.guidance).toContain('nothing here fits')
  })

  async function answerWith(opts: {
    answer: string
    checkedMinutesAgo?: number
    validMinutes?: number
    source?: string
  }) {
    const [req] = await run(
      `select id from operations_requests where operator_id = $1 order by created_at desc limit 1`, [OP],
    )
    const checkedAt = new Date(Date.now() - (opts.checkedMinutesAgo ?? 5) * 60_000)
    await run(
      `update operations_requests
       set state='answered', answer=$2::operations_answer, source=$3, checked_at=$4::timestamptz,
           answer_valid_until=$4::timestamptz + make_interval(mins => $5)
       where id = $1`,
      [req!['id'], opts.answer, opts.source ?? 'fleet calendar', checkedAt.toISOString(),
       opts.validMinutes ?? 240],
    )
  }

  describe('once a person has checked', () => {
    it('relays the answer with when it was checked', async () => {
      await addVehicle()
      await search('ferrari')
      await answerWith({ answer: 'available', checkedMinutesAgo: 12 })

      const result = await search('ferrari')
      expect(result).toMatchObject({
        status: 'ok',
        data: { availability: { status: 'available', source: 'fleet calendar', checkedMinutesAgo: 12 } },
      })
      expect(JSON.stringify(result)).toContain('say when it was checked')
    })

    it('relays unavailable plainly', async () => {
      await addVehicle()
      await search('ferrari')
      await answerWith({ answer: 'unavailable' })
      const result = await search('ferrari')
      expect(result).toMatchObject({ status: 'ok', data: { availability: { status: 'unavailable' } } })
      expect(JSON.stringify(result)).toContain('NOT available')
    })

    /** Section 6: never softened into a maybe. */
    it('tells the model not to soften unknown', async () => {
      await addVehicle()
      await search('ferrari')
      await answerWith({ answer: 'unknown' })
      const result = await search('ferrari')
      expect(JSON.stringify(result)).toContain('Never soften unknown')
    })

    /** "An expired answer is rechecked before it is reused." */
    it('will not reuse an expired answer', async () => {
      await addVehicle()
      await search('ferrari')
      await answerWith({ answer: 'available', checkedMinutesAgo: 500, validMinutes: 240 })

      const result = await search('ferrari')
      expect((result as { data: { availability?: unknown } }).data.availability).toBeUndefined()
      expect(JSON.stringify(result)).toContain('may NOT say available')
    })

    /**
     * The whole reason checked_at is nullable and never defaulted: a row nobody
     * looked at must be unusable, not merely unlikely.
     */
    it('will not use an answer with no time checked', async () => {
      await addVehicle()
      await search('ferrari')
      const [req] = await run(
        `select id from operations_requests where operator_id = $1`, [OP],
      )
      // The database refuses this outright — the constraint is the guarantee,
      // the read path is the second line.
      await expect(
        run(`update operations_requests set state='answered', answer='available' where id=$1`,
            [req!['id']]),
      ).rejects.toThrow(/operations_requests_answer_is_checked/)
    })

    it('does not use an answer for dates it does not cover', async () => {
      await addVehicle()
      await search('ferrari')
      await answerWith({ answer: 'available' })

      // The answer covers 20-23; this asks about 25.
      const later = await createToolBoundary(ctx).call('search_vehicles', {
        vehicle: 'ferrari', startDate: '2026-09-25', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-09-26',
      })
      expect((later as { data: { availability?: unknown } }).data.availability).toBeUndefined()
    })
  })

  it('still refuses a date in the past before it looks at the fleet', async () => {
    await addVehicle()
    const result = await createToolBoundary(ctx).call('search_vehicles', {
      vehicle: 'ferrari', startDate: '2026-09-01', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: null,
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

  it('refuses when no single confirmed vehicle matches the enquiry', async () => {
    const result = await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })
    expect(result).toMatchObject({ status: 'refused', reason: 'nothing_to_do' })
  })

  describe('once the enquiry has a car and dates', () => {
    async function readyToQuote(opts: { rate?: boolean; minimumDays?: number } = {}) {
      const [v] = await run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, provenance, confirmed_by)
         values ($1,'Ferrari','488',2022,'Giallo','exotic','Dubai K 9','VIN9',
                 'operator_confirmed','Owner') returning id`,
        [OP],
      )
      if (opts.rate !== false) {
        await run(
          `insert into vehicle_rates (operator_id, vehicle_id, daily_rate_minor, minimum_days,
                                      deposit_minor, provenance, confirmed_by, confirmed_at)
           values ($1, $2, 150000, $3, 500000, 'operator_confirmed', 'Owner', now())`,
          [OP, v!['id'], opts.minimumDays ?? 1],
        )
      }
      await run(
        `insert into field_evidence (operator_id, enquiry_id, field, value, source_message_id,
                                     verification_state)
         values ($1,$2,'vehicle','Ferrari 488',$3,'customer_stated'),
                ($1,$2,'start_at','2026-09-20',$3,'customer_stated'),
                ($1,$2,'end_at','2026-09-23',$3,'customer_stated')`,
        [OP, ctx.enquiryId, ctx.messageId],
      )
      return v!['id'] as string
    }

    /**
     * The figures are handed over finished.
     *
     * The guarantee moved rather than disappeared. It used to be "the model is
     * told no numbers", which made every price question unanswerable once real
     * rates existed. It is now "the model is told no numbers it could do
     * arithmetic with": the sum is computed in integer fils from a confirmed
     * rate and rendered to a string, so the only thing the model can do with a
     * price is repeat it.
     */
    it('gives the model finished strings and never a minor-unit figure', async () => {
      await readyToQuote()
      const result = await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })

      // 3 days at 1,500 a day is 4,500, and the deposit is 5,000.
      expect(result).toMatchObject({
        status: 'ok',
        data: {
          quoteRequested: true, revision: 1, days: 3,
          total: 'AED 4,500', deposit: 'AED 5,000',
          lines: [{ label: '3 days', amount: 'AED 4,500' }],
        },
      })

      // Minor units never reach the model. Handing over 450000 would invite it
      // to divide by a hundred, and a model doing arithmetic on a price is the
      // thing this boundary exists to prevent.
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain('450000')
      expect(serialised).not.toContain('500000')
      expect(serialised).toContain('Do NOT recalculate')
    })

    /**
     * A price used to say nothing about whether the car was free, and the
     * guidance said so — correctly, because this tool priced from the rate
     * and never looked at the calendar.
     *
     * Read live: "The Ferrari 488 Spider from 25th to 27th September is AED
     * 10,000 for 2 days... Availability still needs to be confirmed." The
     * calendar was complete, the car was free, and the system held it forty
     * seconds later without checking anything. Nobody was wrong; the
     * information never travelled. It costs nothing to look — the vehicle and
     * the dates are already resolved here.
     */
    const quoteFor = async () =>
      (await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })) as {
        data: { availability: string; guidance: string }
      }

    it('will not claim a car is free when the calendar cannot say', async () => {
      await readyToQuote()
      const { data } = await quoteFor()

      expect(data.availability).toBe('unknown')
      expect(data.guidance).toContain('do not say the car is free')
    })

    /** Vouched for by the operator, and nothing against these dates. */
    it('says the car is free when the calendar can say so', async () => {
      await readyToQuote()
      await run(`update operators set availability_calendar_complete = true where id = $1`, [OP])

      const { data } = await quoteFor()
      expect(data.availability).toBe('free')
      expect(data.guidance).toContain('has been confirmed')
    })

    /** A price for a car somebody else has is worse than no price. */
    it('says the car is taken when something is against those dates', async () => {
      const vehicleId = await readyToQuote()
      await run(
        `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date,
                                           reason, recorded_by)
         values ($1,$2,'2026-09-21','2026-09-22','booked','somebody else')`,
        [OP, vehicleId],
      )

      const { data } = await quoteFor()
      expect(data.availability).toBe('taken')
      expect(data.guidance).toContain('is NOT free')
    })

    it('stores the draft for a person to approve', async () => {
      await readyToQuote()
      await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })

      const [quote] = await run(
        `select state::text as state, total_minor, deposit_minor, days, lines,
                approved_by_membership_id
         from quotes where operator_id = $1`, [OP],
      )
      // 3 days x 150000 fils = 450000 fils = AED 4,500.
      expect(quote).toMatchObject({
        state: 'draft', total_minor: 450000, deposit_minor: 500000, days: 3,
        approved_by_membership_id: null,
      })
    })

    it('refuses when the vehicle has no confirmed rate', async () => {
      await readyToQuote({ rate: false })
      const result = await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })
      expect(result).toMatchObject({ status: 'refused', reason: 'no_trusted_source' })
      expect(JSON.stringify(result)).toContain('no confirmed rate')
    })

    it('refuses a rental shorter than the minimum', async () => {
      await readyToQuote({ minimumDays: 7 })
      const result = await createToolBoundary(ctx).call('prepare_quote', { enquiryId: ctx.enquiryId })
      expect(result).toMatchObject({ status: 'refused' })
      expect(JSON.stringify(result)).toContain('7-day minimum')
    })

    /** There is no discount argument, so a discount cannot arrive this way. */
    it('has no way to ask for a discount', async () => {
      await readyToQuote()
      const result = await createToolBoundary(ctx).call('prepare_quote', {
        enquiryId: ctx.enquiryId, discount: 500,
      })
      expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })
    })
  })
})

describe('record_enquiry_fields', () => {
  it('attaches the message the customer actually sent as evidence', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', { forVehicle: null,
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
    await boundary.call('record_enquiry_fields', { forVehicle: null, fields: [{ field: 'start_at', value: '2026-09-18', originalWording: 'Friday' }] })
    const second = await boundary.call('record_enquiry_fields', { forVehicle: null,
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
    await boundary.call('record_enquiry_fields', { forVehicle: null, fields: [{ field: 'vehicle', value: 'Ferrari 488', originalWording: null }] })
    const again = await boundary.call('record_enquiry_fields', { forVehicle: null,
      fields: [{ field: 'vehicle', value: 'Ferrari 488', originalWording: null }],
    })
    expect(again).toMatchObject({ status: 'ok', data: { conflicts: [] } })
  })

  /**
   * The judgement the schema exists to capture, in both directions.
   *
   * These two came one after the other in the same live thread: "Okay, I want
   * a Ferrari 488 Spider" replacing the Huracán, and four minutes later "I
   * want two bookings, one for the Cullinan and one for the Lambo". One is a
   * customer narrowing down and one is a customer taking two cars, the
   * difference is entirely in the words, and getting it backwards either loses
   * a rental or invents one for a car they turned down.
   */
  it('supersedes rather than splitting when they change their mind', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('record_enquiry_fields', {
      forVehicle: null,
      fields: [{ field: 'vehicle', value: 'Lamborghini Huracán', originalWording: null }],
    })
    const changed = await boundary.call('record_enquiry_fields', {
      forVehicle: null,
      fields: [{ field: 'vehicle', value: 'Ferrari 488 Spider', originalWording: null }],
    })

    expect(changed).toMatchObject({ status: 'ok', data: { enquiryId: ctx.enquiryId } })
    const live = await run(
      `select count(*)::int as n from enquiries where conversation_id = $1`, [CONV],
    )
    expect(live[0]!['n']).toBe(1)
  })

  it('opens a separate booking when they want the second car as well', async () => {
    const boundary = createToolBoundary(ctx)
    await boundary.call('record_enquiry_fields', {
      forVehicle: null,
      fields: [
        { field: 'vehicle', value: 'Lamborghini Huracán', originalWording: null },
        { field: 'start_at', value: '2026-09-20', originalWording: 'Sunday' },
      ],
    })
    const second = await boundary.call('record_enquiry_fields', {
      forVehicle: 'Rolls-Royce Cullinan',
      fields: [{ field: 'start_at', value: '2026-09-22', originalWording: 'Tuesday' }],
    })

    expect(second).toMatchObject({ status: 'ok', data: { startedNewBooking: true } })
    const on = (second as { data: { enquiryId: string } }).data.enquiryId
    expect(on).not.toBe(ctx.enquiryId)

    // Each car keeps its own date, rather than one superseding the other.
    const dates = await run(
      `select e.id, fe.field::text as field, fe.value from enquiries e
       join field_evidence fe on fe.enquiry_id = e.id and fe.superseded_at is null
       where e.conversation_id = $1 order by fe.value`, [CONV],
    )
    expect(dates.filter((r) => r['field'] === 'start_at').map((r) => r['value']))
      .toEqual(['2026-09-20', '2026-09-22'])
    expect(dates.filter((r) => r['field'] === 'vehicle').map((r) => r['value']))
      .toEqual(['Lamborghini Huracán', 'Rolls-Royce Cullinan'])
  })

  it('refuses to record an unresolved date as a fact', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', { forVehicle: null,
      fields: [{ field: 'start_at', value: 'next Friday', originalWording: 'next friday' }],
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_arguments' })

    const rows = await run(`select 1 from field_evidence where enquiry_id = $1`, [ctx.enquiryId])
    expect(rows).toHaveLength(0)
  })

  it('refuses a field that is not part of an enquiry', async () => {
    const result = await createToolBoundary(ctx).call('record_enquiry_fields', { forVehicle: null,
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
  /**
   * The quote a customer agreed to, as it would be at the moment they say yes:
   * sent to them, current, and still in date.
   */
  const sentQuote = async (over: Record<string, unknown> = {}) => {
    const rows = await run(
      // A sent quote carries its approver: quotes_approval_is_attributed.
      `insert into quotes (operator_id, conversation_id, enquiry_id, revision, state,
                           total_minor, lines, valid_until,
                           approved_by_membership_id, approved_at)
       values ($1, $2, $3, coalesce($4, 1), coalesce($5, 'sent')::quote_state, 500000,
               '[]'::jsonb, coalesce($6, now() + interval '2 days'), $7, now())
       returning id`,
      [
        OP, CONV, (over['enquiryId'] as string) ?? ctx.enquiryId,
        over['revision'] ?? null, over['state'] ?? null, over['validUntil'] ?? null,
        MEMBER,
      ],
    )
    return rows[0]!['id'] as string
  }

  it('records the yes against the figures they agreed to', async () => {
    const quoteId = await sentQuote()
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId })

    expect(result).toMatchObject({ status: 'ok' })
    const [booking] = await run(
      `select state::text as state, quote_id, requested_from_message_id,
              decided_by_membership_id
       from bookings where operator_id = $1`,
      [OP],
    )
    expect(booking).toMatchObject({
      state: 'requested',
      quote_id: quoteId,
      // Evidenced by the message that was their yes, and decided by nobody.
      requested_from_message_id: ctx.messageId,
      decided_by_membership_id: null,
    })
  })

  /** The conversation column nothing had ever written. */
  it('puts the conversation in front of a person', async () => {
    await createToolBoundary(ctx).call('request_booking_review', { quoteId: await sentQuote() })
    const [row] = await run(
      `select booking_status::text as status from conversations where id = $1`, [CONV],
    )
    expect(row!['status']).toBe('pending')
  })

  /** Said twice because nobody answered. One booking, not two. */
  it('does not open a second booking when they say yes again', async () => {
    const quoteId = await sentQuote()
    const boundary = createToolBoundary(ctx)
    const first = await boundary.call('request_booking_review', { quoteId })
    const again = await boundary.call('request_booking_review', { quoteId })

    expect(again).toMatchObject({ status: 'ok', data: { alreadyRequested: true } })
    expect((again as { data: { bookingId: string } }).data.bookingId)
      .toBe((first as { data: { bookingId: string } }).data.bookingId)
    const rows = await run(`select id from bookings where operator_id = $1`, [OP])
    expect(rows).toHaveLength(1)
  })

  /**
   * "Yes, the 4,500 one" after the rate moved is agreement to terms that no
   * longer exist. Recording it would put the operator in front of somebody
   * holding them to a price they had already withdrawn.
   */
  it('refuses a price that has been replaced', async () => {
    const old = await sentQuote({ revision: 1 })
    await sentQuote({ revision: 2 })
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId: old })

    expect(result).toMatchObject({ status: 'refused' })
    expect(await run(`select id from bookings where operator_id = $1`, [OP])).toHaveLength(0)
  })

  it('refuses a price that has expired', async () => {
    // Before ctx.now, which is what the tool checks against — not wall clock.
    const stale = await sentQuote({ validUntil: new Date('2026-09-13T08:00:00Z') })
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId: stale })
    expect(result).toMatchObject({ status: 'refused' })
  })

  /** With two rentals in a thread, the wrong quote id is an ordinary mistake. */
  it('refuses a quote belonging to their other rental', async () => {
    const other = await run(
      `insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`,
      [OP, CONV],
    )
    const quoteId = await sentQuote({ enquiryId: other[0]!['id'] as string })
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId })

    expect(result).toMatchObject({ status: 'refused' })
    expect(await run(`select id from bookings where operator_id = $1`, [OP])).toHaveLength(0)
  })

  /**
   * The ordinary case. prepare_quote writes a draft and hands the figures
   * straight to the model to state, so a customer's yes almost always lands on
   * a quote that has never been near the approval screen.
   */
  it('records a yes to a draft, which is what customers are actually quoted', async () => {
    const draft = await sentQuote({ state: 'draft' })
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId: draft })
    expect(result).toMatchObject({ status: 'ok' })
  })

  it('refuses a quote somebody here has rejected', async () => {
    const rejected = await sentQuote({ state: 'rejected' })
    const result = await createToolBoundary(ctx).call('request_booking_review', { quoteId: rejected })
    expect(result).toMatchObject({ status: 'refused' })
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

/**
 * A fleet nobody can list.
 *
 * Ten cars is a WhatsApp list and forty is as many as the model is handed to
 * read. An operator with a hundred and twenty has neither, and the answer is
 * not a longer message — it is the question a salesperson asks first.
 */
describe('search_vehicles on a large fleet', () => {
  const addCars = async (
    n: number, category: string, rateMinor: number | null, seats: number | null = 2,
  ) => {
    for (let i = 0; i < n; i++) {
      const [car] = await run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, seats, provenance, confirmed_by)
         values ($1,'Make','Model ' || $2,2023,'Black',$3::vehicle_category,'P'||$2,'V'||$2,
                 $4, 'operator_confirmed','Owner') returning id`,
        [OP, `${category}-${i}`, category, seats],
      )
      if (rateMinor !== null) {
        // provenance matters: the fleet search only joins a rate a person
        // confirmed, so a placeholder one reads as no price at all.
        await run(
          `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                                      minimum_days, provenance, confirmed_by, confirmed_at)
           values ($1, $2, 'AED', $3, 1, 'operator_confirmed', 'Owner', now())`,
          [OP, car!['id'], rateMinor],
        )
      }
    }
  }

  const search = (args: Record<string, unknown>) =>
    createToolBoundary(ctx).call('search_vehicles', {
      vehicle: null, category: null, maxDayRateMinor: null, minSeats: null, order: null,
      startDate: null, endDate: null, ...args,
    })

  it('narrows to one kind of car', async () => {
    await addCars(3, 'suv', 400000)
    await addCars(2, 'sports', 500000)

    const result = await search({ category: 'sports' })
    const { fleet } = (result as { data: { fleet: unknown[] } }).data
    expect(fleet).toHaveLength(2)
  })

  it('narrows to what the customer said they would spend', async () => {
    await addCars(2, 'suv', 400000)
    await addCars(2, 'exotic', 900000)

    const result = await search({ maxDayRateMinor: 500000 })
    const { fleet } = (result as { data: { fleet: unknown[] } }).data
    expect(fleet).toHaveLength(2)
  })

  /**
   * A car nobody has priced is not excluded by a budget. We do not know what
   * it costs, and dropping it would hide cars from a customer on the strength
   * of a figure nobody entered.
   */
  it('keeps an unpriced car whatever the budget', async () => {
    await addCars(1, 'suv', null)

    const result = await search({ maxDayRateMinor: 100 })
    const { fleet } = (result as { data: { fleet: unknown[] } }).data
    expect(fleet).toHaveLength(1)
  })

  /** Show a few, say there are more, ask what would narrow it. */
  it('shows the dearest ten and says how many it did not', async () => {
    await addCars(14, 'luxury', 300000)

    const result = await search({})
    const data = (result as { data: { fleet: unknown[]; notShown?: number; guidance: string } }).data
    expect(data.fleet).toHaveLength(10)
    expect(data.notShown).toBe(4)
    expect(data.guidance).toContain('4 more')
  })

  /**
   * The count has to come from how many matched, not from how many came back.
   * The query returns one page of twenty, so a fleet of sixty would otherwise
   * report ten more when there are fifty — a number that is wrong in the
   * direction that makes the operator look small.
   */
  it('counts the ones it did not show against the whole fleet, not the page', async () => {
    await addCars(60, 'luxury', 300000)

    const data = (await search({}) as { data: { fleet: unknown[]; notShown?: number } }).data
    expect(data.fleet).toHaveLength(10)
    expect(data.notShown).toBe(50)
  })

  /**
   * The failure that made this worth returning to. With a hundred and twenty
   * cars the query returns one page and the page was always the dearest, so
   * "what is your cheapest car" was answered out of the ten most expensive —
   * confidently, and wrong.
   */
  it('answers the cheapest question from the cheap end of the fleet', async () => {
    await addCars(30, 'luxury', 900000)
    await addCars(1, 'sedan', 40000)

    const data = (await search({ order: 'cheapest' }) as {
      data: { fleet: Array<{ dayRate: string | null }> }
    }).data
    expect(data.fleet[0]!.dayRate).toBe('AED 400')
  })

  it('still answers the dearest question from the other end', async () => {
    await addCars(30, 'luxury', 900000)
    await addCars(1, 'exotic', 2500000)

    const data = (await search({}) as {
      data: { fleet: Array<{ dayRate: string | null }> }
    }).data
    expect(data.fleet[0]!.dayRate).toBe('AED 25,000')
  })

  /**
   * Six people either fit or they do not, so a car whose seat count nobody
   * recorded is left out rather than offered and hoped about.
   */
  it('narrows to cars that will hold everybody', async () => {
    await addCars(2, 'suv', 400000, 7)
    await addCars(3, 'sports', 500000, 2)
    await addCars(1, 'luxury', 400000, null)

    const data = (await search({ minSeats: 6 }) as { data: { fleet: unknown[] } }).data
    expect(data.fleet).toHaveLength(2)
  })

  /** Narrowed, the count is of what matched — not of the fleet. */
  it('counts against the filter once one is applied', async () => {
    await addCars(30, 'suv', 300000)
    await addCars(5, 'sports', 300000)

    const data = (await search({ category: 'sports' }) as { data: { notShown?: number } }).data
    expect(data.notShown).toBeUndefined()
  })

  it('says nothing about more when everything fits', async () => {
    await addCars(3, 'luxury', 300000)

    const data = (await search({}) as { data: { notShown?: number } }).data
    expect(data.notShown).toBeUndefined()
  })
})

/**
 * The prefetch hands the model every car and every rate, and the model called
 * search_vehicles anyway on nineteen of the pilot's twenty-four two-round
 * turns — one of them for "Ferrari 488, please." Two rewordings measured
 * identically, so it is withheld rather than discouraged.
 *
 * Measured per case, same build, same session: "show me your cars" went from 4
 * of 12 turns taking a second round to 0 of 12, and picking a car off the list
 * from 12 of 12 to 9 of 12.
 */
describe('a tool withheld because its answer is already in the prompt', () => {
  const withheld = () => createToolBoundary(ctx, { without: ['search_vehicles'] })

  it('is not offered to the model', () => {
    const names = withheld().definitions.map((d) => d.name)
    expect(names).not.toContain('search_vehicles')
    expect(names).toContain('prepare_quote')
    expect(names).toHaveLength(TOOL_NAMES.length - 1)
  })

  /**
   * Withheld from the list is not the guarantee. Section 18.8's promise is
   * that there is no path to an implementation except through `call`, so a
   * name the model produces regardless has to be refused in the same place.
   */
  it('is refused even when the model names it anyway', async () => {
    const result = await withheld().call('search_vehicles', {
      vehicle: null, category: null, maxDayRateMinor: null,
      minSeats: null, order: null, startDate: null, endDate: null,
    })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') return
    expect(result.reason).toBe('nothing_to_do')
    // Telling it the answer is in front of it is what stops a second attempt.
    expect(result.detail).toContain('already in your instructions')
  })

  it('leaves every other tool working', async () => {
    const result = await withheld().call('get_operator_policy', { topic: 'deposit' })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') return
    // Refused for having no published answer, which is the ordinary path.
    expect(result.reason).toBe('no_approved_answer')
  })

  it('withholds nothing when nothing is asked for', () => {
    expect(createToolBoundary(ctx).definitions).toHaveLength(TOOL_NAMES.length)
  })
})

/**
 * A tool that requires an id nothing hands out cannot be called correctly.
 *
 * Read live, at the moment of sale. prepare_quote returned figures and no id;
 * request_booking_review asks for one. So when the customer said yes the model
 * built a quote id out of the two handles it had — the enquiry id with the
 * revision appended, "401767f8-…-r9" — Postgres refused the cast, the boundary
 * rethrew it as an infrastructure failure, and the turn died. The customer got
 * silence and the salesperson got "AI unavailable — reply manually".
 */
describe('the id that ties a quote to a yes', () => {
  it('hands the quote id back so it can be booked', async () => {
    const [car] = await run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category,
                             plate, chassis_number, active, provenance, confirmed_by)
       values ($1,'Ferrari','488','Spider',2022,'Giallo','exotic','D 9','V9',true,
               'operator_confirmed','Owner')
       returning id`,
      [OP],
    )
    await run(
      `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                                  minimum_days, provenance, confirmed_by, confirmed_at)
       values ($1, $2, 'AED', 500000, 1, 'operator_confirmed', 'Owner', now())`,
      [OP, car!['id']],
    )
    const boundary = createToolBoundary(ctx)
    await boundary.call('record_enquiry_fields', {
      forVehicle: null,
      fields: [
        { field: 'vehicle', value: 'Ferrari 488 Spider', originalWording: null },
        { field: 'start_at', value: '2026-09-25', originalWording: null },
        { field: 'end_at', value: '2026-09-27', originalWording: null },
      ],
    })

    const quote = await boundary.call('prepare_quote', { enquiryId: ctx.enquiryId })
    expect(quote).toMatchObject({ status: 'ok' })
    const quoteId = (quote as { data: { quoteId: string } }).data.quoteId
    expect(quoteId).toMatch(/^[0-9a-f-]{36}$/i)

    // And it is the id the booking tool accepts, which is the whole point.
    expect(await boundary.call('request_booking_review', { quoteId }))
      .toMatchObject({ status: 'ok' })
  })

  /** The invented id, exactly as it arrived. A refusal, never a crash. */
  it('refuses an id that is not one instead of killing the turn', async () => {
    const result = await createToolBoundary(ctx).call('request_booking_review', {
      quoteId: `${ctx.enquiryId}-r9`,
    })
    expect(result).toMatchObject({ status: 'refused' })
  })
})
