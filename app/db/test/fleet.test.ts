import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { canonicalVehicleName } from '../src/queries/fleet.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OP}', 'Vyra Pilot'), ('${RIVAL}', 'Rival');
    insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                          chassis_number, provenance, confirmed_by)
    values ('${OP}','Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 1','V1',
            'operator_confirmed','Owner'),
           ('${OP}','Ferrari','488','Spider',2022,'Giallo','exotic','D 2','V2',
            'operator_confirmed','Owner'),
           ('${OP}','Rolls-Royce','Cullinan',null,2023,'White','suv','D 3','V3',
            'operator_confirmed','Owner');
  `)
})

/**
 * Two code paths wrote the vehicle field and disagreed about its name. The
 * model recorded the full name; the turn's auto-record wrote `make model` and
 * dropped the variant. The same car went in as two values that each superseded
 * the other — sixteen seconds apart in one case, four in another — and the
 * enquiry looked like somebody changing their mind about a car they had not
 * stopped talking about.
 */
describe('one car, one spelling', () => {
  const resolve = (spoken: string) => canonicalVehicleName(run, OP, spoken)

  it.each([
    ['Lamborghini Huracán', 'Lamborghini Huracán Tecnica'],
    ['Lamborghini Huracán Tecnica', 'Lamborghini Huracán Tecnica'],
    ['huracan', 'Lamborghini Huracán Tecnica'],
    ['Ferrari 488', 'Ferrari 488 Spider'],
    ['Ferrari 488 Spider', 'Ferrari 488 Spider'],
    ['ferrari', 'Ferrari 488 Spider'],
  ])('resolves %j to %j', async (spoken, expected) => {
    expect(await resolve(spoken)).toBe(expected)
  })

  /**
   * A description of the car, which is how the agent often records it. One
   * way round only, "Ferrari 488 Spider, Giallo Modena yellow" matched nothing
   * and the quote was refused four turns running in simulation.
   */
  it.each([
    ['Ferrari 488 Spider, Giallo Modena yellow', 'Ferrari 488 Spider'],
    ['the yellow Ferrari 488 please', 'Ferrari 488 Spider'],
    ['Rolls-Royce Cullinan (white)', 'Rolls-Royce Cullinan'],
  ])('resolves the description %j to %j', async (spoken, expected) => {
    expect(await resolve(spoken)).toBe(expected)
  })

  /** A car with no variant is already its own full name. */
  it('leaves a car that has no variant alone', async () => {
    expect(await resolve('Rolls-Royce Cullinan')).toBe('Rolls-Royce Cullinan')
  })

  /** Accents and all, or neither — the same fold prepare_quote uses. */
  it('matches without the accent', async () => {
    expect(await resolve('Huracan Tecnica')).toBe('Lamborghini Huracán Tecnica')
  })

  /**
   * A name nobody can resolve is still what the customer said, and the caller
   * keeps it rather than losing it.
   */
  it.each(['Bugatti Chiron', 'a nice one', ''])(
    'says nothing for %j rather than guessing', async (spoken) => {
      expect(await resolve(spoken)).toBeNull()
    },
  )

  /** Two matches is not an answer. */
  it('says nothing when the words fit more than one car', async () => {
    await run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by)
       values ($1,'Lamborghini','Huracán','Evo',2024,'Giallo','exotic','D 4','V4',
               'operator_confirmed','Owner')`,
      [OP],
    )
    expect(await resolve('Lamborghini Huracán')).toBeNull()
  })

  it('never reaches into another operator’s fleet', async () => {
    expect(await canonicalVehicleName(run, RIVAL, 'Ferrari 488')).toBeNull()
  })

  /** A car nobody confirmed is not a car this may name. */
  it('ignores a placeholder vehicle', async () => {
    await run(
      `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                             chassis_number, provenance)
       values ($1,'Bentley','Continental',2023,'Black','luxury','D 9','V9','placeholder')`,
      [OP],
    )
    expect(await resolve('Bentley')).toBeNull()
  })
})
