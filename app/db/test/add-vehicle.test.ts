import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { addVehicle, problemWithVehicle, type NewVehicle } from '../src/queries/add-vehicle.ts'
import { searchFleet } from '../src/queries/fleet.ts'
import { calculateDraftQuote, listRates } from '../src/queries/quotes.ts'
import { findVehicleImages } from '../src/queries/photos.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const OWNER = '44444444-4444-4444-4444-444444444444'
const OWNER_USER = '10000000-0000-0000-0000-000000000001'
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
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', 'Asia/Dubai'), ('${RIVAL}', 'Rival Rentals', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${OWNER}', '${OP}', '${OWNER_USER}', 'admin');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Layla');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const urus = (over: Partial<NewVehicle> = {}): NewVehicle => ({
  operatorId: OP,
  membershipId: OWNER,
  confirmedBy: 'owner@example.com',
  make: 'Lamborghini',
  model: 'Urus',
  year: 2024,
  colour: 'Nero',
  category: 'suv',
  plate: 'Dubai A 12345',
  chassisNumber: 'zpbua1zl0rla12345',
  seats: 5,
  dailyRateMinor: 350000,
  depositMinor: 500000,
  ...over,
})

describe('adding a car from the dashboard', () => {
  /** The card's finish line: added, priced, and the agent can quote it. */
  it('is found by the agent and can be quoted straight away', async () => {
    const added = await addVehicle(transact, urus())
    if (!added.ok) throw new Error('expected the car to be added: ' + added.problem)

    const found = await searchFleet(run, OP, 'Urus')
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0]).toMatchObject({
      id: added.vehicleId, make: 'Lamborghini', model: 'Urus', dailyRateMinor: 350000,
    })

    const quote = await calculateDraftQuote(run, {
      operatorId: OP, conversationId: CONV, enquiryId: null, vehicleId: added.vehicleId,
      startDate: '2026-10-01', endDate: '2026-10-04',
    })
    if (!quote.ok) throw new Error('expected a quote: ' + quote.refusal.reason)
    expect(quote.quote.depositMinor).toBe(500000)
    expect(quote.quote.totalMinor).toBeGreaterThan(0)
  })

  it('carries the name of whoever saved it, on the car and on the rate', async () => {
    const added = await addVehicle(transact, urus())
    if (!added.ok) throw new Error(added.problem)

    const [car] = await run(
      `select provenance::text as provenance, confirmed_by, confirmed_by_membership_id, confirmed_at
       from vehicles where id = $1`,
      [added.vehicleId],
    )
    expect(car).toMatchObject({
      provenance: 'operator_confirmed', confirmed_by: 'owner@example.com',
      confirmed_by_membership_id: OWNER,
    })
    expect(car!['confirmed_at']).not.toBeNull()

    const rates = await listRates(run, OP)
    expect(rates.find((r) => r.vehicleId === added.vehicleId)).toMatchObject({
      dailyRateMinor: 350000, confirmedBy: 'owner@example.com',
    })

    const [audit] = await run(
      `select action, actor_id from audit_events where subject_id = $1`, [added.vehicleId],
    )
    expect(audit).toMatchObject({ action: 'vehicle.added', actor_id: OWNER })
  })

  it('keeps the photographs, and a collage only when there are two or more', async () => {
    const one = await addVehicle(transact, urus({
      photoUrls: ['https://example.com/urus-1.jpg'],
      collageUrl: 'https://inbox.example.com/api/fleet-photo/x',
    }))
    if (!one.ok) throw new Error(one.problem)
    const [single] = await run(`select collage_url from vehicles where id = $1`, [one.vehicleId])
    expect(single!['collage_url']).toBeNull()

    const two = await addVehicle(transact, urus({
      model: 'Huracán', category: 'exotic', plate: 'Dubai B 2', chassisNumber: 'VIN-HURACAN',
      photoUrls: ['https://example.com/h-1.jpg', 'https://example.com/h-2.jpg'],
      collageUrl: 'https://inbox.example.com/api/fleet-photo/y',
    }))
    if (!two.ok) throw new Error(two.problem)
    const images = await findVehicleImages(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' })
    expect(images).toEqual({
      photos: ['https://example.com/h-1.jpg', 'https://example.com/h-2.jpg'],
      collage: 'https://inbox.example.com/api/fleet-photo/y',
    })
  })

  /** The collage link is built from the id, so the form chooses it before saving. */
  it('uses the id the caller chose, when it chose one', async () => {
    const chosen = '99999999-9999-4999-8999-999999999999'
    const added = await addVehicle(transact, urus({ vehicleId: chosen }))
    expect(added).toEqual({ ok: true, vehicleId: chosen })
  })

  /** "DUBAI A12345" is the same plate; two rows would be one car offered twice. */
  it('refuses a plate or chassis number already in the fleet, however it is spaced', async () => {
    await addVehicle(transact, urus())

    expect(await addVehicle(transact, urus({ plate: 'DUBAI A12345', chassisNumber: 'OTHER' })))
      .toEqual({ ok: false, problem: 'plate_taken' })
    expect(await addVehicle(transact, urus({ plate: 'Dubai Z 9', chassisNumber: 'ZPBUA1ZL0-RLA12345' })))
      .toEqual({ ok: false, problem: 'chassis_taken' })

    const [count] = await run(`select count(*)::int as n from vehicles where operator_id = $1`, [OP])
    expect(count!['n']).toBe(1)
  })

  /** Two operators can both rent in Dubai; a plate is unique within one fleet. */
  it("does not count another operator's cars as a clash", async () => {
    await run(
      `insert into vehicles (operator_id, make, model, year, colour, category, plate, chassis_number)
       values ($1,'Ferrari','488',2022,'Rosso','exotic','Dubai A 12345','ZPBUA1ZL0RLA12345')`,
      [RIVAL],
    )
    const added = await addVehicle(transact, urus())
    expect(added.ok).toBe(true)
  })

  /** Nothing half-saved: a car that went in without its rate is one the agent names and cannot price. */
  it('writes nothing when the rate cannot be saved', async () => {
    await expect(addVehicle(transact, urus({ confirmedBy: null as unknown as string })))
      .rejects.toThrow()
    const [count] = await run(`select count(*)::int as n from vehicles`, [])
    expect(count!['n']).toBe(0)
  })
})

describe('what is wrong with the form', () => {
  const now = new Date('2026-09-26T00:00:00Z')

  it('accepts a complete car', () => {
    expect(problemWithVehicle(urus(), now)).toBeNull()
  })

  it('names the first thing to fix', () => {
    expect(problemWithVehicle(urus({ make: '  ' }), now)).toBe('make')
    expect(problemWithVehicle(urus({ model: '' }), now)).toBe('model')
    expect(problemWithVehicle(urus({ year: 223 }), now)).toBe('year')
    expect(problemWithVehicle(urus({ year: 2028 }), now)).toBe('year')
    expect(problemWithVehicle(urus({ colour: '' }), now)).toBe('colour')
    expect(problemWithVehicle(urus({ category: 'truck' }), now)).toBe('category')
    expect(problemWithVehicle(urus({ plate: '' }), now)).toBe('plate')
    expect(problemWithVehicle(urus({ chassisNumber: '' }), now)).toBe('chassis')
    expect(problemWithVehicle(urus({ seats: 0 }), now)).toBe('seats')
    expect(problemWithVehicle(urus({ dailyRateMinor: 0 }), now)).toBe('rate')
    expect(problemWithVehicle(urus({ depositMinor: -1 }), now)).toBe('deposit')
  })

  it("allows next year's model and leaves deposit and seats optional", () => {
    expect(problemWithVehicle(urus({ year: 2027, depositMinor: null, seats: null }), now)).toBeNull()
  })
})
