import { civilDateIn, formatCivil } from '@vyra/contracts'
import { searchFleet } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { searchVehiclesSchema } from './schemas.js'
import type { z } from 'zod'

/**
 * Note what the model never sees: the plate and the chassis number.
 *
 * They are in the database because Operations needs them, and they are not in
 * this result because a sales conversation has no use for them. A model that
 * cannot see an identifier cannot recite it to the wrong person.
 */
export type VehicleSearchResult = {
  /**
   * Cars in the fleet matching the request. Fleet facts, not availability.
   *
   * No `available` field, on purpose. An earlier draft of this type had one,
   * and a boolean there is a lie waiting to happen: whatever it said would be
   * read as an answer to the question the customer actually asked.
   */
  fleet: Array<{
    make: string
    model: string
    variant: string | null
    year: number
    colour: string
    category: string
    engine: string | null
    powerHp: number | null
    seats: number | null
  }>
  /** Always false until Operations can record who checked and when. */
  availabilityChecked: false
  /** What the model must do with this, in words it can relay to the customer. */
  guidance: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Mandatory check (section 18.8): validated dates and a trusted inventory source.
 *
 * Both checks run. The first is implemented; the second currently refuses.
 *
 * Dates are validated here rather than trusted from the model because a model
 * that has mis-resolved "next Friday" will produce a well-formed date that is
 * simply wrong, and a strict schema cannot tell the difference — section 18.8
 * says as much. Shape, ordering and a past start date are all checked.
 *
 * The fleet is now readable. Availability is not, and the two are different
 * questions that arrive in the same sentence.
 *
 * "Do you have a yellow Ferrari" is a fleet fact — stable for years, and a
 * salesperson could answer it from memory. "Is it free on Thursday" changes
 * hourly, and section 9 requires any answer to carry who checked and when.
 * Vehicle availability records arrive with the Operations console in build plan
 * step 30; until then no answer to the second question exists, and inventing
 * one promises a customer a car that may already be out.
 *
 * So this returns the cars and refuses the availability, in one result. The
 * model gets something genuinely useful to say — the right model, the colour,
 * the engine — without being handed a fact nobody has verified.
 *
 * Only `operator_confirmed` rows are returned. A fleet record still marked
 * `placeholder` describes a car nobody has said exists, and quoting a chassis
 * number for an invented car is worse than saying nothing.
 */
export async function searchVehicles(
  ctx: ToolContext,
  args: z.infer<typeof searchVehiclesSchema>,
): Promise<ToolResult<VehicleSearchResult>> {
  const today = formatCivil(civilDateIn(ctx.now, ctx.timezone))

  for (const [label, value] of [['start', args.startDate], ['end', args.endDate]] as const) {
    if (value === null) continue
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      return refuse('invalid_arguments', `The ${label} date "${value}" is not a real YYYY-MM-DD date.`)
    }
  }

  if (args.startDate !== null && args.startDate < today) {
    return refuse(
      'invalid_arguments',
      `The start date ${args.startDate} is in the past — today is ${today} for this operator. Ask the customer which date they meant.`,
    )
  }

  if (args.startDate !== null && args.endDate !== null && args.endDate < args.startDate) {
    return refuse(
      'invalid_arguments',
      `The end date ${args.endDate} is before the start date ${args.startDate}. Ask the customer to confirm the dates.`,
    )
  }

  if (args.startDate === null) {
    return refuse(
      'invalid_arguments',
      'Availability needs a start date. Ask the customer when they want the car before checking.',
    )
  }

  const found = await searchFleet(ctx.run, ctx.operatorId, args.vehicle)

  if (found.fleetSize === 0) {
    return refuse(
      'no_trusted_source',
      'This operator has not confirmed any vehicles yet, so nothing can be said about the fleet. Tell the customer you are checking with the team.',
      'confirm the fleet — no vehicles are recorded',
    )
  }

  return ok({
    fleet: found.matches.map((v) => ({
      make: v.make,
      model: v.model,
      variant: v.variant,
      year: v.year,
      colour: v.colour,
      category: v.category,
      engine: v.engine,
      powerHp: v.powerHp,
      seats: v.seats,
    })),
    availabilityChecked: false,
    guidance: found.matches.length === 0
      ? 'No car in the fleet matches that description. Say so plainly and offer to check what else might suit — do not invent a car.'
      : 'These cars are in the fleet. You may describe them. You may NOT say any of them is available, free, or bookable on these dates: nobody has checked. Tell the customer you are confirming availability with the team.',
  },
  // Only when a car was actually matched: asking whether they stock Bugattis
  // leaves nobody anything to check.
  found.matches.length === 0
    ? undefined
    : `check availability of ${found.matches.map((v) => `${v.make} ${v.model}`).join(', ')} for ${args.startDate}${args.endDate === null ? '' : ` to ${args.endDate}`}`)
}
