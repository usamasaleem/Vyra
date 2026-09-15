import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkCalendar, listAvailability, recordUnavailable, releaseAvailability,
} from '../src/queries/availability.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let run: QueryRunner
let vehicleId: string

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');`)
  const [v] = await run(
    `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by)
     values ($1,'Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 1','VIN1',
             'operator_confirmed','Owner') returning id`,
    [OP],
  )
  vehicleId = v!['id'] as string
})

const block = (startDate: string, endDate: string, reason = 'booked') =>
  recordUnavailable(run, {
    operatorId: OP, vehicleId, startDate, endDate, reason, recordedBy: 'Sara',
  })

const check = (startDate: string, endDate: string | null) =>
  checkCalendar(run, { operatorId: OP, vehicleId, startDate, endDate })

describe('checkCalendar', () => {
  it('answers no when a booking covers the dates', async () => {
    await block('2026-10-20', '2026-10-23')
    expect(await check('2026-10-21', '2026-10-22'))
      .toMatchObject({ state: 'booked', until: '2026-10-23', reason: 'booked' })
  })

  /** Overlap, not containment: part of the range taken is the range not free. */
  it.each([
    ['2026-10-18', '2026-10-21'],
    ['2026-10-22', '2026-10-25'],
    ['2026-10-19', '2026-10-24'],
    ['2026-10-20', '2026-10-20'],
    ['2026-10-23', null],
  ])('answers no when %s to %s overlaps at all', async (start, end) => {
    await block('2026-10-20', '2026-10-23')
    expect((await check(start, end as string | null)).state).toBe('booked')
  })

  it.each([
    ['2026-10-24', '2026-10-26'],
    ['2026-10-17', '2026-10-19'],
  ])('says nothing about %s to %s, which does not overlap', async (start, end) => {
    await block('2026-10-20', '2026-10-23')
    expect((await check(start, end)).state).toBe('unknown')
  })

  /**
   * The distinction the whole design rests on. An empty calendar says nobody
   * recorded a booking, which is a fact about the calendar and not about the
   * car. Treating it as "free" is how an agent promises a vehicle already out.
   */
  it('is unknown, not free, when nothing is booked', async () => {
    expect(await check('2026-10-20', '2026-10-23')).toEqual({ state: 'unknown' })
  })

  it('is free only once the operator says their calendar is complete', async () => {
    await run(`update operators set availability_calendar_complete = true where id = $1`, [OP])
    expect(await check('2026-10-20', '2026-10-23')).toEqual({ state: 'free' })
  })

  it('still answers no from a complete calendar', async () => {
    await run(`update operators set availability_calendar_complete = true where id = $1`, [OP])
    await block('2026-10-20', '2026-10-23')
    expect((await check('2026-10-21', '2026-10-22')).state).toBe('booked')
  })

  it('ignores a booking that was released', async () => {
    const { id } = await block('2026-10-20', '2026-10-23')
    await releaseAvailability(run, { operatorId: OP, id: id!, releasedBy: 'Sara' })
    expect((await check('2026-10-21', '2026-10-22')).state).toBe('unknown')
  })

  it('belongs to one operator', async () => {
    await block('2026-10-20', '2026-10-23')
    expect(await checkCalendar(run, {
      operatorId: '11111111-1111-1111-1111-1111111111bb',
      vehicleId, startDate: '2026-10-21', endDate: '2026-10-22',
    })).toMatchObject({ state: 'unknown' })
  })
})

describe('the calendar a person reads', () => {
  it('shows what is coming and hides what was released', async () => {
    await block('2099-10-20', '2099-10-23')
    const { id } = await block('2099-11-01', '2099-11-03')
    await releaseAvailability(run, { operatorId: OP, id: id!, releasedBy: 'Sara' })

    const open = await listAvailability(run, OP)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      vehicleLabel: 'Lamborghini Huracán Tecnica', startDate: '2099-10-20', recordedBy: 'Sara',
    })

    // The released one is history, and history is still readable.
    expect(await listAvailability(run, OP, { includeReleased: true })).toHaveLength(2)
  })

  it('leaves yesterday out of the calendar', async () => {
    await block('2020-01-01', '2020-01-05')
    expect(await listAvailability(run, OP)).toHaveLength(0)
  })
})

describe('what the database refuses', () => {
  it('refuses a block that ends before it starts', async () => {
    await expect(block('2026-10-23', '2026-10-20')).rejects.toThrow()
  })

  /** A booking that vanished with no name against it cannot be explained. */
  it('refuses an anonymous release', async () => {
    const { id } = await block('2026-10-20', '2026-10-23')
    await expect(run(
      `update vehicle_availability set released_at = now() where id = $1`, [id],
    )).rejects.toThrow()
  })
})
