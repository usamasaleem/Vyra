import type { QueryRunner } from '../runner.js'

/**
 * Seasonal prices: a percentage on the rental for the days a season covers.
 *
 * The rental is worked out first, from the operator's own day, week and month
 * rates, and a season bends that total rather than replacing it. So a week in
 * December is the weekly rate plus December's percentage, which is how an
 * operator says it — "the week is 30,000, December is twenty percent more" —
 * and not a daily rate with a surcharge that quietly undid their weekly tier.
 *
 * Each rental day belongs to at most one season. When two cover the same day
 * the car's own beats the fleet's, and then the newest wins: it is the later
 * decision about the same days.
 */

export type RateSeason = {
  id: string
  vehicleId: string | null
  /** "All cars" when vehicleId is null. */
  vehicleLabel: string
  name: string
  startDate: string
  endDate: string
  percent: number
  createdBy: string
}

type LiveSeason = { id: string; vehicleId: string | null; name: string; startDate: string; endDate: string; percent: number }

const dayAfter = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The seasons that touch any day of this rental, most specific and newest first. */
export async function liveSeasons(
  run: QueryRunner,
  operatorId: string,
  vehicleId: string,
  startDate: string,
  endDate: string,
): Promise<LiveSeason[]> {
  // The rental's days are start up to, not including, the end — the day it
  // comes back is not charged. A same-day rental is still its first day.
  const lastDay = endDate > startDate ? dayAfter(endDate, -1) : startDate
  const rows = await run(
    `select id, vehicle_id, name, start_date, end_date, percent
     from rate_seasons
     where operator_id = $1 and removed_at is null
       and (vehicle_id is null or vehicle_id = $2::uuid)
       and start_date <= $4 and end_date >= $3
     order by (vehicle_id is null), created_at desc`,
    [operatorId, vehicleId, startDate, lastDay],
  )
  return rows.map((r) => ({
    id: r['id'] as string,
    vehicleId: (r['vehicle_id'] as string) ?? null,
    name: r['name'] as string,
    startDate: r['start_date'] as string,
    endDate: r['end_date'] as string,
    percent: Number(r['percent']),
  }))
}

/**
 * One quote line per season the rental falls in.
 *
 * The share of the rental a season's days make up, times its percentage. The
 * rental's own average day is used rather than the daily rate, so a week in
 * season is charged on the weekly price the customer is paying. Rounded to
 * whole currency in the customer's favour, as a standing discount is: a
 * surcharge down, a reduction up.
 */
export function seasonLines(
  seasons: LiveSeason[],
  startDate: string,
  days: number,
  rentalMinor: number,
): Array<{ label: string; amountMinor: number }> {
  const counts = new Map<string, number>()
  for (let i = 0; i < days; i++) {
    const day = dayAfter(startDate, i)
    const season = seasons.find((s) => s.startDate <= day && s.endDate >= day)
    if (season !== undefined) counts.set(season.id, (counts.get(season.id) ?? 0) + 1)
  }

  const lines: Array<{ label: string; amountMinor: number }> = []
  for (const season of seasons) {
    const n = counts.get(season.id)
    if (n === undefined) continue
    const amountMinor = Math.floor((rentalMinor * n * season.percent) / (days * 100) / 100) * 100
    if (amountMinor === 0) continue
    const pct = `${season.percent > 0 ? '+' : ''}${season.percent}%`
    lines.push({
      label: n === days ? `${season.name} ${pct}` : `${season.name} ${pct}, ${n} of ${days} days`,
      amountMinor,
    })
  }
  return lines
}

export async function listRateSeasons(run: QueryRunner, operatorId: string): Promise<RateSeason[]> {
  const rows = await run(
    `select s.id, s.vehicle_id, s.name, s.start_date, s.end_date, s.percent, s.created_by,
            coalesce(v.make || ' ' || v.model || coalesce(' ' || v.variant, '') || ' · ' || v.colour,
                     'All cars') as vehicle_label
     from rate_seasons s
     left join vehicles v on v.id = s.vehicle_id and v.operator_id = s.operator_id
     where s.operator_id = $1 and s.removed_at is null
     order by s.start_date, s.created_at`,
    [operatorId],
  )
  return rows.map((r) => ({
    id: r['id'] as string,
    vehicleId: (r['vehicle_id'] as string) ?? null,
    vehicleLabel: r['vehicle_label'] as string,
    name: r['name'] as string,
    startDate: r['start_date'] as string,
    endDate: r['end_date'] as string,
    percent: Number(r['percent']),
    createdBy: r['created_by'] as string,
  }))
}

export type SeasonProblem = 'name' | 'dates' | 'percent' | 'vehicle'

/** Checked here as well as by the table, so the form can say which field is wrong. */
export function checkSeason(input: {
  name: string
  startDate: string
  endDate: string
  percent: number
}): SeasonProblem | null {
  if (input.name.trim() === '' || input.name.trim().length > 60) return 'name'
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (!iso.test(input.startDate) || !iso.test(input.endDate)) return 'dates'
  if (Number.isNaN(Date.parse(`${input.startDate}T00:00:00Z`))
    || Number.isNaN(Date.parse(`${input.endDate}T00:00:00Z`))) return 'dates'
  if (input.endDate < input.startDate) return 'dates'
  if (!Number.isInteger(input.percent) || input.percent === 0
    || input.percent < -90 || input.percent > 300) return 'percent'
  return null
}

export async function addRateSeason(
  run: QueryRunner,
  input: {
    operatorId: string
    vehicleId: string | null
    name: string
    startDate: string
    endDate: string
    percent: number
    createdBy: string
  },
): Promise<{ ok: true; seasonId: string } | { ok: false; problem: SeasonProblem }> {
  const problem = checkSeason(input)
  if (problem !== null) return { ok: false, problem }
  if (input.vehicleId !== null) {
    const [car] = await run(
      `select 1 from vehicles where id = $1::uuid and operator_id = $2`,
      [input.vehicleId, input.operatorId],
    )
    if (car === undefined) return { ok: false, problem: 'vehicle' }
  }
  const [row] = await run(
    `insert into rate_seasons (operator_id, vehicle_id, name, start_date, end_date, percent, created_by)
     values ($1, $2::uuid, $3, $4, $5, $6, $7)
     returning id`,
    [input.operatorId, input.vehicleId, input.name.trim(), input.startDate, input.endDate,
     input.percent, input.createdBy],
  )
  return { ok: true, seasonId: row!['id'] as string }
}

export async function removeRateSeason(
  run: QueryRunner,
  input: { operatorId: string; seasonId: string; removedBy: string },
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(input.seasonId)) return false
  const rows = await run(
    `update rate_seasons set removed_at = now(), removed_by = $3
     where id = $1::uuid and operator_id = $2 and removed_at is null
     returning id`,
    [input.seasonId, input.operatorId, input.removedBy],
  )
  return rows.length > 0
}
