import type { QueryRunner } from '../runner.js'

/**
 * Reading the fleet — the half of `search_vehicles` that can be answered from
 * a table.
 *
 * Section 9 splits the question the customer asks into two. "Do you have a
 * yellow Ferrari" is a fleet fact, stable for years, and this answers it.
 * "Is it free on Thursday" is an availability fact that changes hourly and
 * needs a person who checked; nothing here answers that, and the shape of the
 * return type says so rather than leaving it to a comment.
 *
 * Confirmed rows only. A fleet record whose provenance is still `placeholder`
 * describes a car nobody has said exists, and quoting a chassis number for an
 * invented car is worse than saying nothing.
 */

export type FleetVehicle = {
  id: string
  make: string
  model: string
  variant: string | null
  year: number
  colour: string
  category: string
  plate: string
  chassisNumber: string
  engine: string | null
  powerHp: number | null
  transmission: string | null
  drivetrain: string | null
  seats: number | null
  doors: number | null
}

export type FleetSearch = {
  /** Confirmed, active cars matching the request. */
  matches: FleetVehicle[]
  /**
   * Always false, and deliberately not optional.
   *
   * Every caller has to acknowledge that a fleet match is not an availability
   * answer. It becomes meaningful when the Operations console lands (build plan
   * step 30) and someone can record what they checked and when.
   */
  availabilityChecked: false
  /** Confirmed cars in the fleet at all, so "none match" can be told apart
   *  from "the operator has not entered their fleet yet". */
  fleetSize: number
}

const SEARCH_SQL = `
  select id, make, model, variant, year, colour, category::text as category,
         plate, chassis_number, engine, power_hp, transmission, drivetrain, seats, doors
  from vehicles
  where operator_id = $1
    and active
    and provenance = 'operator_confirmed'
    -- A loose match on purpose: customers write "lambo", "the yellow ferrari",
    -- "range rover". Narrowing this is the model's job through the argument it
    -- passes, not this query's.
    and ($2::text is null or (
      make    ilike '%' || $2 || '%' or
      model   ilike '%' || $2 || '%' or
      variant ilike '%' || $2 || '%' or
      colour  ilike '%' || $2 || '%' or
      (make || ' ' || model) ilike '%' || $2 || '%'
    ))
  order by make, model
  limit 20
`

export async function searchFleet(
  run: QueryRunner,
  operatorId: string,
  query: string | null,
): Promise<FleetSearch> {
  const rows = await run(SEARCH_SQL, [operatorId, query])
  const [size] = await run(
    `select count(*)::int as n from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'`,
    [operatorId],
  )

  return {
    matches: rows.map((r) => ({
      id: r['id'] as string,
      make: r['make'] as string,
      model: r['model'] as string,
      variant: (r['variant'] as string) ?? null,
      year: Number(r['year']),
      colour: r['colour'] as string,
      category: r['category'] as string,
      plate: r['plate'] as string,
      chassisNumber: r['chassis_number'] as string,
      engine: (r['engine'] as string) ?? null,
      powerHp: r['power_hp'] === null ? null : Number(r['power_hp']),
      transmission: (r['transmission'] as string) ?? null,
      drivetrain: (r['drivetrain'] as string) ?? null,
      seats: r['seats'] === null ? null : Number(r['seats']),
      doors: r['doors'] === null ? null : Number(r['doors']),
    })),
    availabilityChecked: false,
    fleetSize: Number(size?.['n'] ?? 0),
  }
}
