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
  /**
   * The operator's confirmed day rate, in minor units, or null when nobody has
   * set one.
   *
   * Null is not "free" and not "ask us" — it is the reason this car cannot be
   * priced, and the caller must say so rather than reach for a neighbouring
   * car's number. Only `operator_confirmed`, current rows are joined; an
   * unconfirmed rate is a figure nobody has stood behind.
   */
  dailyRateMinor: number | null
  currency: string
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

/**
 * Every word must match somewhere in the car's description, not the whole
 * phrase in one column.
 *
 * The first version matched the query as a single substring against each
 * column in turn. "yellow Ferrari" then found nothing: `make` is 'Ferrari',
 * `colour` is 'Giallo Modena (yellow)', and neither contains the phrase. The
 * agent told a customer "we don't have a yellow Ferrari" about a car sitting in
 * the fleet — a false statement produced by a true tool result, which is the
 * worst shape this kind of bug takes.
 *
 * Concatenating the searchable fields and requiring every word means "yellow
 * ferrari", "ferrari yellow" and "yellow 488" all find it, while "yellow
 * lamborghini" correctly finds nothing.
 */
const SEARCH_SQL = `
  select v.id, v.make, v.model, v.variant, v.year, v.colour, v.category::text as category,
         v.plate, v.chassis_number, v.engine, v.power_hp, v.transmission, v.drivetrain,
         v.seats, v.doors,
         r.daily_rate_minor, coalesce(r.currency, 'AED') as currency
  from vehicles v
  left join vehicle_rates r
    on r.vehicle_id = v.id and r.operator_id = v.operator_id
   and r.effective_to is null and r.provenance = 'operator_confirmed'
  where v.operator_id = $1
    and v.active
    and v.provenance = 'operator_confirmed'
    and (
      $2::text[] is null
      or cardinality($2::text[]) = 0
      or (
        v.make || ' ' || v.model || ' ' || coalesce(v.variant, '') || ' ' ||
        v.colour || ' ' || v.category::text || ' ' || v.year::text
      ) ilike all ($2::text[])
    )
  -- Dearest first, so "what is the most expensive car you have" is answered by
  -- the order of the result rather than by the model comparing numbers.
  -- Unpriced cars sort last: they cannot answer a price question at all.
  order by r.daily_rate_minor desc nulls last, v.make, v.model
  limit 20
`

/**
 * Words worth requiring. Short connectives are dropped because a model may
 * pass "a yellow Ferrari" or "the Huracan", and requiring "a" or "the" to
 * appear in a car's description would match nothing.
 */
const IGNORED = new Set(['a', 'an', 'the', 'in', 'of', 'for', 'my', 'your', 'any', 'car'])

function searchPatterns(query: string | null): string[] | null {
  if (query === null) return null
  const words = query
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((w) => w.length > 0 && !IGNORED.has(w))
  return words.map((w) => `%${w}%`)
}

export async function searchFleet(
  run: QueryRunner,
  operatorId: string,
  query: string | null,
): Promise<FleetSearch> {
  const rows = await run(SEARCH_SQL, [operatorId, searchPatterns(query)])
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
      dailyRateMinor: r['daily_rate_minor'] == null ? null : Number(r['daily_rate_minor']),
      currency: r['currency'] as string,
    })),
    availabilityChecked: false,
    fleetSize: Number(size?.['n'] ?? 0),
  }
}
