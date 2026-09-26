import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkCalendar, recordUnavailable } from '../src/queries/availability.ts'
import {
  backOnFrom, listCarsOffTheRoad, setCarStatus, UNTIL_FURTHER_NOTICE,
} from '../src/queries/car-status.ts'
import { searchFleet } from '../src/queries/fleet.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let run: QueryRunner
let vehicleId: string

/** Today on the operator's clock, and days either side of it. */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date())
const day = (offset: number) => {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`insert into operators (id, name, timezone, availability_calendar_complete)
                 values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', true);`)
  const [v] = await run(
    `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by)
     values ($1,'Rolls-Royce','Cullinan',2024,'Black','suv','D 2','VIN2',
             'operator_confirmed','Owner') returning id`,
    [OP],
  )
  vehicleId = v!['id'] as string
})

const setStatus = (status: Parameters<typeof setCarStatus>[1]['status'], backOn: string | null) =>
  setCarStatus(run, { operatorId: OP, vehicleId, status, backOn, recordedBy: 'Sara' })

const check = (startDate: string, endDate: string) =>
  checkCalendar(run, { operatorId: OP, vehicleId, startDate, endDate })

describe('setCarStatus', () => {
  it('takes the car out of every day before it is back, and no later', async () => {
    expect(await setStatus('garage', day(3))).toEqual({ ok: true, clashingBookings: 0 })

    expect(await check(day(0), day(0))).toMatchObject({ state: 'booked', reason: 'garage', until: day(2) })
    expect(await check(day(2), day(5))).toMatchObject({ state: 'booked' })
    // The day it is back, it can go out.
    expect(await check(day(3), day(5))).toEqual({ state: 'free' })
  })

  it('keeps a car with no date back off sale until somebody sets it back', async () => {
    await setStatus('off_sale', null)
    expect(await check(day(300), day(301))).toMatchObject({ state: 'booked', until: UNTIL_FURTHER_NOTICE })

    const [off] = await listCarsOffTheRoad(run, OP)
    expect(off).toMatchObject({ status: 'off_sale', backOn: null, since: today, recordedBy: 'Sara' })

    expect(await setStatus('available', null)).toEqual({ ok: true, clashingBookings: 0 })
    expect(await check(day(300), day(301))).toEqual({ state: 'free' })
    expect(await listCarsOffTheRoad(run, OP)).toEqual([])
  })

  /** One reason it is off, not two: the older must not outlive the newer. */
  it('replaces the status the car has today rather than adding to it', async () => {
    await setStatus('damaged', null)
    await setStatus('garage', day(2))

    const off = await listCarsOffTheRoad(run, OP)
    expect(off).toHaveLength(1)
    expect(off[0]).toMatchObject({ status: 'garage', backOn: day(2) })
    expect(await check(day(2), day(2))).toEqual({ state: 'free' })
  })

  /**
   * The car cannot be driven whatever the calendar says, so the status goes on
   * anyway — and somebody has to call those customers.
   */
  it('leaves customers\' bookings in place and counts the ones inside the time off', async () => {
    await run(
      `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason,
                                         recorded_by, booking_id)
       values ($1, $2, $3, $4, 'booked', 'agent', gen_random_uuid())`,
      [OP, vehicleId, day(1), day(2)],
    )

    expect(await setStatus('damaged', day(5))).toEqual({ ok: true, clashingBookings: 1 })
    expect(await setStatus('damaged', day(1))).toEqual({ ok: true, clashingBookings: 0 })

    // Back on the road releases the status and nothing else.
    await setStatus('available', null)
    expect(await check(day(1), day(1))).toMatchObject({ state: 'booked', reason: 'booked' })
  })

  it('refuses a day back that is not after today', async () => {
    expect(await setStatus('garage', today)).toMatchObject({ ok: false, reason: 'back_on_not_after_today' })
    expect(await listCarsOffTheRoad(run, OP)).toEqual([])
  })

  it('refuses a car from another fleet', async () => {
    const result = await setCarStatus(run, {
      operatorId: '22222222-2222-2222-2222-222222222222', vehicleId, status: 'garage',
      backOn: null, recordedBy: 'Sara',
    })
    expect(result).toMatchObject({ ok: false, reason: 'no_such_car' })
  })

  it('reads a service block entered by hand as the car being in service', async () => {
    await recordUnavailable(run, {
      operatorId: OP, vehicleId, startDate: day(-1), endDate: day(1), reason: 'maintenance', recordedBy: 'Omar',
    })
    const [off] = await listCarsOffTheRoad(run, OP)
    expect(off).toMatchObject({ status: 'maintenance', backOn: day(2), recordedBy: 'Omar' })
  })
})

describe('searchFleet', () => {
  /**
   * Still found: leaving it out would have the agent tell somebody asking for
   * the Cullinan next month that there is no Cullinan.
   */
  it('still finds a car off the road, with the day it is back', async () => {
    await setStatus('garage', day(4))
    const found = await searchFleet(run, OP, 'Cullinan')
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0]!.offTheRoad).toEqual({ backOn: day(4) })
  })

  it('says nothing about a car that is on the road', async () => {
    await recordUnavailable(run, {
      operatorId: OP, vehicleId, startDate: day(1), endDate: day(2), reason: 'booked', recordedBy: 'Sara',
    })
    // A future service is not today's status either.
    await recordUnavailable(run, {
      operatorId: OP, vehicleId, startDate: day(5), endDate: day(6), reason: 'maintenance', recordedBy: 'Sara',
    })
    const found = await searchFleet(run, OP, 'Cullinan')
    expect(found.matches[0]!.offTheRoad).toBeNull()
  })

  it('reads an open-ended status as no date back', async () => {
    await setStatus('damaged', null)
    const found = await searchFleet(run, OP, null)
    expect(found.matches[0]!.offTheRoad).toEqual({ backOn: null })
  })
})

describe('backOnFrom', () => {
  it('is the day after the last day off, across a month end', () => {
    expect(backOnFrom('2026-09-30')).toBe('2026-10-01')
    expect(backOnFrom(UNTIL_FURTHER_NOTICE)).toBeNull()
  })
})
