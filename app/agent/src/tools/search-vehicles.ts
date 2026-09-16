import { civilDateIn, formatCivil } from '@vyra/contracts'
import {
  checkCalendar, findCurrentAnswer, formatMoneyMinor, raiseOperationsRequest, searchFleet,
} from '@vyra/db'
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
 * How many cars can simply be handed to the model.
 *
 * Under this, the whole fleet goes back on every search and the model decides
 * what the customer meant. Above it, the words still narrow first, because a
 * few hundred cars in every result is a bill rather than a feature.
 *
 * The reason for doing this at all: SQL is the wrong thing to be matching
 * "Huracan" against "Huracán", "the orange one" against "Arancio Borealis", or
 * "something loud" against a V10. A model is good at that and was never given
 * the chance — it asked a string comparison, got no rows, and told a customer
 * we did not have a car that was sitting in the fleet with a confirmed rate.
 *
 * The safety property is untouched. The model still only ever sees cars this
 * operator has confirmed, so it cannot invent one; it just gets to read the
 * list instead of being handed a verdict.
 */
const FLEET_SMALL_ENOUGH_TO_READ = 40

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

  const filters = {
    category: args.category ?? null,
    maxDayRateMinor: args.maxDayRateMinor ?? null,
    minSeats: args.minSeats ?? null,
    order: args.order ?? 'dearest',
  } as const
  const found = await searchFleet(ctx.run, ctx.operatorId, args.vehicle, filters)

  if (found.fleetSize === 0) {
    return refuse(
      'no_trusted_source',
      'This operator has not confirmed any vehicles yet, so nothing can be said about the fleet. Tell the customer you are checking with the team.',
      'confirm the fleet — no vehicles are recorded',
    )
  }

  /**
   * The whole fleet, when there is little enough of it to read.
   *
   * Fetched in addition to the filtered matches, not instead: the filter still
   * decides which single vehicle an availability answer is about, because
   * "is it free" needs one car and the catalogue is many.
   */
  const catalogue = found.fleetSize <= FLEET_SMALL_ENOUGH_TO_READ && args.vehicle !== null
    ? await searchFleet(ctx.run, ctx.operatorId, null, filters)
    : null

  /**
   * The catalogue is a fallback, not the default. When the words did match, the
   * customer asked about a specific car and should hear about that one — a
   * result padded with every other car invites a reply that lists the fleet at
   * somebody who named one model.
   */
  const matched = found.matches.length > 0 ? found.matches : (catalogue?.matches ?? [])

  /**
   * How many cars come back at once.
   *
   * A WhatsApp list holds ten rows, and a reply naming more than that is a
   * wall nobody reads — so there is no point handing the model forty and
   * hoping for restraint. Past this it gets the closest ones and is told how
   * many it did not see, which is what a salesperson does: show a few, say
   * there are more, ask what would narrow it.
   *
   * Already in the order that was asked for. Re-sorting here is what made
   * "what is your cheapest car" return the dearest ten of a hundred and twenty
   * — the query had been asked for the right end of the list and this threw
   * the answer away.
   */
  const SHOWN_AT_MOST = 10
  const visible = matched.slice(0, SHOWN_AT_MOST)
  /**
   * Against how many matched, not how many came back. The query returns one
   * page, so `matched.length` tops out at twenty however large the fleet is —
   * and "and ten more" said to somebody with a hundred and ten more is worse
   * than saying nothing.
   */
  const matchedCount = found.matches.length > 0 ? found.matchCount : (catalogue?.matchCount ?? 0)
  const notShown = Math.max(0, matchedCount - visible.length)

  const fleet = visible.map((v) => ({
    make: v.make,
    model: v.model,
    variant: v.variant,
    year: v.year,
    colour: v.colour,
    /**
     * The operator's own words about this car, when they set any. Worth the
     * model knowing: a salesperson mentions that something is the one people
     * ask for. It is a claim a person at the operator made, like the rate.
     */
    ...(v.highlight === null ? {} : { highlight: v.highlight }),
    category: v.category,
    engine: v.engine,
    powerHp: v.powerHp,
    seats: v.seats,
    dayRate: v.dailyRateMinor === null ? null : formatMoneyMinor(v.dailyRateMinor, v.currency),
  }))

  if (found.matches.length === 0) {
    return ok({
      fleet,
      fleetSize: found.fleetSize,
      guidance: catalogue === null
        /**
         * Too many cars to hand over, so the words were all there was to go on
         * — and the honest thing is to say how big the fleet is and ask the
         * question a salesperson asks first. An operator with a hundred and
         * twenty cars cannot have them listed, and a customer who says "show
         * me your cars" has not told anybody anything yet.
         */
        ? `No car matched that out of ${found.fleetSize} in the fleet. Do not invent one and do not try to list them — say roughly how many there are and ask what sort of thing they are after, or what they want to spend a day. Then search again with category or maxDayRateMinor.`
        : 'The words they used did not match anything, but this is the operator\'s ENTIRE fleet — every car they have. Read it and decide for yourself whether one of these is what they meant: spelling and accents ("Huracan" is the Huracán), nicknames, a colour in another language ("the orange one" is the Arancio Borealis), or a description like "something loud". If one of them fits, answer about that car and use its exact make and model in any further tool call. Only say the operator does not have it once you have looked at this list and nothing here fits.',
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
      fleetSize: found.fleetSize,
      ...(notShown > 0 ? { notShown } : {}),
      guidance:
        'These cars are in the fleet and you may describe them, including any dayRate shown — a named person at the operator set it. A car with dayRate null has no confirmed price: say that it needs checking rather than quoting another car\'s figure. You have NOT checked whether any of them is free, so do not say available, free or bookable. If the customer wants a total or a booking, ask which dates.'
        + (notShown > 0
          ? ` These are ${fleet.length} of ${matchedCount} that matched, ${filters.order === 'cheapest' ? 'cheapest' : 'dearest'} first. Say there are ${notShown} more rather than listing these and stopping, and ask what would narrow it — a kind of car, or what they want to spend a day.`
          : ''),
    })
  }

  /**
   * One car, one answer. With several matches there is no single availability
   * fact to state, so the agent describes them and asks which one — which is
   * what a salesperson would do rather than reading out three calendars.
   */
  const only = found.matches.length === 1 ? found.matches[0]! : null

  /**
   * The calendar first, because it is the operator's own record rather than a
   * question somebody answered once and which has since expired.
   *
   * A block is a no, with authority and with no expiry. Silence is only a yes
   * for an operator who has said they keep the calendar current; for everyone
   * else it stays unknown and the question still goes to a person.
   */
  const calendar = only === null
    ? null
    : await checkCalendar(ctx.run, {
        operatorId: ctx.operatorId,
        vehicleId: only.id,
        startDate: args.startDate,
        endDate: args.endDate,
      })

  if (calendar?.state === 'booked') {
    return ok({
      fleet,
      availability: {
        status: 'unavailable',
        note: `Booked until ${calendar.until}.`,
        source: 'the operator\'s own calendar',
        checkedMinutesAgo: 0,
      },
      guidance:
        'This car is recorded as taken for those dates in the operator\'s own calendar. Say so plainly, say when it frees up if that helps, and offer alternatives or other dates. Do not describe it as possibly available or suggest checking again — this is the operator\'s record, not a guess.',
    })
  }

  if (calendar?.state === 'free') {
    return ok({
      fleet,
      availability: {
        status: 'available',
        note: null,
        source: 'the operator\'s own calendar',
        checkedMinutesAgo: 0,
      },
      guidance:
        'Nothing is booked against this car for those dates and this operator keeps their calendar current, so you may say it is free. Do not say it is held or reserved for them — that is a separate step a person takes.',
    })
  }

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
        'NEXT: call prepare_quote now, before you reply. You have the dates and this car has a confirmed rate, so the total can be worked out and given to the customer in this same message. Do not answer with the day rate alone and do not say you will come back with the full price — that is the thing you are being asked for, and it is one tool call away. '
        + 'Then, in that same reply: these cars are in the fleet and you may describe them, including any dayRate shown. Nobody has checked whether any is free on these dates, so you may NOT say available, free, or bookable — say you are confirming that with the team, which has been asked. '
        + 'Availability is the only open question. A price does not wait on it: three days cost what three days cost whether or not the car turns out to be free.',
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
    'Operations could not confirm yet — it depends on another booking. Say exactly that. Do not present it as probably free. The price does not depend on it: if you have dates, prepare_quote and give the total anyway.',
  unknown: () =>
    'Operations could not determine availability. Say it is unknown and that someone will confirm. Never soften unknown into "probably" or "should be". The price is a separate question you can still answer: if you have dates, prepare_quote and give the total.',
}
