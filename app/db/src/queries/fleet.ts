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
  /** A few words the operator wants beside this car. Null when they set none. */
  highlight: string | null
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
  /** Confirmed, active cars matching the request. One page of them. */
  matches: FleetVehicle[]
  /**
   * How many matched in total, which is not how many came back.
   *
   * The two are different the moment a fleet is bigger than a page, and
   * telling a customer "and ten more" when there are a hundred and ten is
   * worse than telling them nothing.
   */
  matchCount: number
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
         v.highlight,
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
      -- Folded on both sides: a customer typing "Huracan" must find the
      -- "Huracán" in the fleet. They did not, once, and were told we did not
      -- have the car.
      or public.vyra_fold(
        v.make || ' ' || v.model || ' ' || coalesce(v.variant, '') || ' ' ||
        v.colour || ' ' || v.category::text || ' ' || v.year::text
      ) like all (array(select public.vyra_fold(unnest($2::text[]))))
    )
`

/**
 * Which end of the price list the customer is asking about.
 *
 * The order used to be fixed at dearest-first, on the reasoning that "what is
 * your most expensive car" should be answered by the result rather than by the
 * model comparing numbers. True, and it quietly broke the opposite question
 * the moment a fleet outgrew one page: with a hundred and twenty cars, "what
 * is your cheapest?" returned the twenty dearest, and the cheapest car was not
 * among them at all. The model could only answer from what it was handed, so
 * it would have named the cheapest of the ten most expensive cars in the
 * fleet and been wrong with complete confidence.
 *
 * Unpriced cars sort last either way. They cannot answer a price question in
 * either direction, and putting them at the top of "cheapest" because null
 * sorts low would be the same bug wearing a different hat.
 */
export type FleetOrder = 'dearest' | 'cheapest'

/**
 * Applied to the outer query, on the outer column names.
 *
 * Not inside the subquery: PostgreSQL does not promise that a subquery's
 * ordering survives into the query that selects from it, and a LIMIT over an
 * order that was only probably there is how "the cheapest car" becomes
 * whichever row the planner felt like keeping.
 */
const ORDER_BY: Record<FleetOrder, string> = {
  dearest: 'daily_rate_minor desc nulls last, make, model',
  cheapest: 'daily_rate_minor asc nulls last, make, model',
}

/**
 * One page of them, and separately how many there are.
 *
 * The limit has always been here — a few hundred cars in every tool result is
 * a bill rather than a feature. What was missing is that the caller could not
 * tell a fleet of twenty from a fleet of two hundred, because both come back
 * as twenty rows. Saying "and ten more" to somebody with a hundred and ten
 * more is worse than saying nothing.
 */
const PAGE = 20

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

/**
 * What a customer said about the kind of car and what they will pay.
 *
 * Separate from the free-text query because they are different sorts of thing:
 * the text is a guess at a name and these are facts the customer stated. A
 * fleet of a hundred and twenty cannot be listed, read by a model, or put in a
 * WhatsApp list — it has to be narrowed, and this is what narrows it.
 */
export type FleetFilters = {
  category?: string | null
  maxDayRateMinor?: number | null
  /**
   * Smallest number of seats that will do. A family of six is a hard
   * constraint in a way that a colour is not, and the fleet table has known
   * this about every car since it was built.
   */
  minSeats?: number | null
  /** Which end of the price list they are asking about. Dearest by default. */
  order?: FleetOrder
}

export async function searchFleet(
  run: QueryRunner,
  operatorId: string,
  query: string | null,
  filters: FleetFilters = {},
): Promise<FleetSearch> {
  /**
   * The filters wrap the match rather than joining it, so the free-text search
   * and the stated constraints stay separable — one is a guess at a name and
   * the other is something the customer said.
   */
  const narrow = (inner: string) => `
    select * from (${inner}) matched
    where ($3::text is null or matched.category::text = $3)
      -- A car with no confirmed rate is not excluded by a budget. We do not
      -- know what it costs, and dropping it would quietly hide cars from a
      -- customer on the strength of a figure nobody has entered.
      and ($4::bigint is null or matched.daily_rate_minor is null
           or matched.daily_rate_minor <= $4)
      -- Seats are the opposite case, and deliberately so. An unknown seat
      -- count fails a seat requirement, because six people either fit or they
      -- do not, and offering a car that might not hold them is the kind of
      -- helpfulness that ends at the kerb with luggage on the pavement.
      and ($5::int is null or matched.seats >= $5)`

  const args = [operatorId, searchPatterns(query), filters.category ?? null,
                filters.maxDayRateMinor ?? null, filters.minSeats ?? null]

  const rows = await run(
    `${narrow(SEARCH_SQL)} order by ${ORDER_BY[filters.order ?? 'dearest']} limit ${PAGE}`,
    args,
  )
  const [matched] = await run(`select count(*)::int as n from (${narrow(SEARCH_SQL)}) counted`, args)
  const [size] = await run(
    `select count(*)::int as n from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'`,
    [operatorId],
  )

  return {
    matchCount: Number(matched?.['n'] ?? rows.length),
    matches: rows.map((r) => ({
      id: r['id'] as string,
      make: r['make'] as string,
      model: r['model'] as string,
      variant: (r['variant'] as string) ?? null,
      year: Number(r['year']),
      colour: r['colour'] as string,
      highlight: (r['highlight'] as string) ?? null,
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
