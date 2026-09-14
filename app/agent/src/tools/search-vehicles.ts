import { civilDateIn, formatCivil } from '@vyra/contracts'
import { findCurrentAnswer, formatMoneyMinor, raiseOperationsRequest, searchFleet } from '@vyra/db'
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
   *
   * A day rate IS included, and dearest first. It is a fleet fact in the same
   * way the engine is: a named person set it, it is versioned, and the previous
   * one is kept. Withholding it was right while no rates existed and wrong the
   * moment they did — it made "what do you charge for the Cullinan" impossible
   * to answer about a car whose price was sitting confirmed in the database.
   *
   * A price is still not an offer. It says what the car costs, never that it is
   * free on the customer's dates, and the guidance keeps those apart.
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
    /**
     * The confirmed day rate, already formatted, or null when nobody has set
     * one. Formatted rather than numeric so the model repeats a string instead
     * of doing arithmetic on a price.
     *
     * Null means unpriced, which is a thing to say out loud — not a reason to
     * quote the car next to it.
     */
    dayRate: string | null
  }>
  /**
   * Present only when a person has checked and the answer has not expired.
   *
   * Absent is not "no" — it is "nobody has looked", which the guidance says in
   * words the model can relay. Section 6: an unknown answer is communicated as
   * unknown, never softened into a maybe.
   */
  availability?: {
    status: 'available' | 'unavailable' | 'pending_confirmation' | 'unknown'
    note: string | null
    /** Where the person looked. */
    source: string
    checkedMinutesAgo: number
  }
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

  const found = await searchFleet(ctx.run, ctx.operatorId, args.vehicle)

  if (found.fleetSize === 0) {
    return refuse(
      'no_trusted_source',
      'This operator has not confirmed any vehicles yet, so nothing can be said about the fleet. Tell the customer you are checking with the team.',
      'confirm the fleet — no vehicles are recorded',
    )
  }

  const fleet = found.matches.map((v) => ({
    make: v.make,
    model: v.model,
    variant: v.variant,
    year: v.year,
    colour: v.colour,
    category: v.category,
    engine: v.engine,
    powerHp: v.powerHp,
    seats: v.seats,
    dayRate: v.dailyRateMinor === null ? null : formatMoneyMinor(v.dailyRateMinor, v.currency),
  }))

  if (found.matches.length === 0) {
    return ok({
      fleet,
      guidance:
        'No car in the fleet matches that description. Say so plainly and offer to check what else might suit — do not invent a car.',
    })
  }

  /**
   * No dates, but a real question.
   *
   * This used to refuse outright, which meant a customer asking "what is your
   * most expensive car" got nothing back at all — not even the fleet — and the
   * agent fell back on "I'll check with the team" about cars and prices sitting
   * confirmed in the database. The date is what availability needs; it was
   * never what the fleet or the rate needed.
   *
   * So the two halves are separated: describe and price the cars, refuse the
   * availability, and ask for the dates that would let it be checked.
   */
  if (args.startDate === null) {
    return ok({
      fleet,
      guidance:
        'These cars are in the fleet and you may describe them, including any dayRate shown — a named person at the operator set it. A car with dayRate null has no confirmed price: say that it needs checking rather than quoting another car\'s figure. You have NOT checked whether any of them is free, so do not say available, free or bookable. If the customer wants a total or a booking, ask which dates.',
    })
  }

  /**
   * One car, one answer. With several matches there is no single availability
   * fact to state, so the agent describes them and asks which one — which is
   * what a salesperson would do rather than reading out three calendars.
   */
  const only = found.matches.length === 1 ? found.matches[0]! : null

  const current = only === null
    ? null
    : await findCurrentAnswer(ctx.run, {
        operatorId: ctx.operatorId,
        vehicleId: only.id,
        startDate: args.startDate,
        endDate: args.endDate,
      })

  if (current !== null) {
    return ok({
      fleet,
      availability: {
        status: current.answer,
        note: current.note,
        source: current.source,
        checkedMinutesAgo: current.checkedMinutesAgo,
      },
      // Falls back to the unknown wording rather than to silence: a new answer
      // value added later must not slip out with no instruction attached.
      guidance: (GUIDANCE_FOR[current.answer] ?? GUIDANCE_FOR['unknown']!)(current.checkedMinutesAgo),
    })
  }

  /**
   * Nobody has checked, so ask. The request is raised here rather than left to
   * the model, because an availability question that produces no request is a
   * customer told "I'll check" by a system that will not.
   */
  await raiseOperationsRequest(ctx.run, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
    kind: 'availability',
    vehicleId: only?.id ?? null,
    requestedVehicle: args.vehicle,
    startDate: args.startDate,
    endDate: args.endDate,
  })

  return ok(
    {
      fleet,
      guidance:
        'These cars are in the fleet and you may describe them. Nobody has checked whether any is free on these dates, so you may NOT say available, free, or bookable. Tell the customer you are confirming with the team — it has been asked.',
    },
    `check availability of ${found.matches.map((v) => `${v.make} ${v.model}`).join(', ')} for ${args.startDate}${args.endDate === null ? '' : ` to ${args.endDate}`}`,
  )
}

/**
 * What the model may say, per answer.
 *
 * The wording carries the check time, because section 9 requires an
 * availability answer to be given with when it was verified — "free as of an
 * hour ago" is a different promise from "free", and only one of them is one the
 * operator can stand behind.
 */
const GUIDANCE_FOR: Record<string, (minutesAgo: number) => string> = {
  available: (m) =>
    `Operations confirmed this was free, checked ${m} minute(s) ago. You may say so, and say when it was checked. Do not say it is booked or held for them — that is a separate step a person takes.`,
  unavailable: () =>
    'Operations confirmed this is NOT available for those dates. Say so plainly and offer to check alternatives or other dates.',
  pending_confirmation: () =>
    'Operations could not confirm yet — it depends on another booking. Say exactly that. Do not present it as probably free.',
  unknown: () =>
    'Operations could not determine availability. Say it is unknown and that someone will confirm. Never soften unknown into "probably" or "should be".',
}
