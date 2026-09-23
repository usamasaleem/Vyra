import { POLICY_TOPICS } from '@vyra/contracts'
import { ENQUIRY_FIELDS } from '@vyra/db'
import { z } from 'zod'

/**
 * Build plan step 24 — the argument schemas for the six tools.
 *
 * Section 18.8, citing [T7]: "Use explicit strict schemas with all properties
 * required, nullable values for optional inputs, and no additional properties."
 * `z.strictObject` gives the last of those; writing optionals as `.nullable()`
 * rather than `.optional()` gives the first two. `z.toJSONSchema` then emits
 * the same shape for the provider, so there is one definition rather than a
 * hand-maintained copy that drifts.
 *
 * The same section is equally clear about what schemas do *not* do: "Strict
 * schemas improve argument shape, but do not establish whether a requested
 * action is authorized or a fact is true." Everything below validates shape.
 * Authority and truth are checked in the tool bodies, after this passes.
 *
 * Note what is absent from every schema here: `operator_id`. See `ToolContext`.
 */

export const getOperatorPolicySchema = z.strictObject({
  topic: z.enum(POLICY_TOPICS).describe('Which approved policy answer to retrieve.'),
})

export const searchVehiclesSchema = z.strictObject({
  /** Free text because customers say "a Lamborghini" and "something red and loud". */
  vehicle: z.string().min(1).nullable()
    .describe('Vehicle, model or class the customer asked for. Null returns the whole fleet, which is what a question about the range or the dearest car needs.'),
  /**
   * The two things a salesperson asks before showing anything, and the only
   * way a large fleet can be shown at all.
   *
   * Ten cars is a WhatsApp list; forty is as many as the model is handed to
   * read. An operator with a hundred and twenty has neither, and the answer is
   * not a longer message — it is the question a person would ask first.
   *
   * Nullable and required, like everything else here. Tried optional first,
   * which is the natural shape for a filter — absence and null mean the same
   * thing — and it failed the boundary test: section 18.8 requires every
   * property to be required, because that is what OpenAI's strict function
   * calling means by strict. The rule is right and worth more than the
   * convenience.
   */
  category: z.enum(['exotic', 'luxury', 'suv', 'sports', 'convertible', 'sedan']).nullable()
    .describe('Narrow to one kind of car. Null for any. Use it when the customer says what sort of thing they want rather than naming a model.'),
  maxDayRateMinor: z.number().int().positive().nullable()
    .describe('Most they will pay per day, in the smallest currency unit — 300000 for AED 3,000. Null for any. Only from something the customer actually said about budget, never a guess.'),
  minSeats: z.number().int().positive().nullable()
    .describe('Fewest seats that will do, when the customer said how many people. Null for any. A car whose seat count nobody recorded is left out, because six people either fit or they do not.'),
  order: z.enum(['dearest', 'cheapest']).nullable()
    .describe('Which end of the price list to return. Use cheapest when they ask for the cheapest or say they want something affordable. Null means dearest, which is what "what do you have" wants. Only ten cars come back, so on a large fleet this decides whether the car they asked about is in the answer at all.'),
  startDate: z.string().nullable()
    .describe('Rental start as YYYY-MM-DD in the operator timezone. Null if unknown — do not guess, and do not withhold the call because you lack it. Cars and rates come back either way; only availability needs a date.'),
  endDate: z.string().nullable()
    .describe('Rental end as YYYY-MM-DD in the operator timezone. Null if unknown.'),
})

export const prepareQuoteSchema = z.strictObject({
  enquiryId: z.string().describe('The enquiry to quote. Must be the enquiry under discussion.'),
})

export const recordEnquiryFieldsSchema = z.strictObject({
  fields: z.array(
    z.strictObject({
      field: z.enum(ENQUIRY_FIELDS).describe('Which enquiry field this value belongs to.'),
      value: z.string().min(1).describe(
        'The normalised value. start_at and end_at MUST be YYYY-MM-DD, already resolved against '
        + 'the operator\'s today — "20 September", "next Friday" and "the 20th" are all rejected. '
        + 'Resolving them is what lets the price be worked out; an unrecorded date means no quote '
        + 'can be produced for this customer at all. Keep what they actually typed in '
        + 'originalWording.',
      ),
      originalWording: z.string().nullable()
        .describe('What the customer actually typed, if it differs from the value.'),
    }),
  ).min(1).describe('Facts the customer stated in this conversation.'),
  /**
   * The one judgement code cannot make for itself.
   *
   * Whether a second car is an addition or a change of mind is a reading of
   * what somebody meant — "actually make it the Ferrari" supersedes, "I want
   * two bookings, one Cullinan and one Lambo" does not — and the difference is
   * in the language, not in the data. So the model says which, and everything
   * that follows is the code's.
   */
  forVehicle: z.string().nullable().describe(
    'Null almost always. Name a car here ONLY when the customer wants this car AS WELL AS '
    + 'another one they are still taking — two rentals at the same time, like "the Cullinan '
    + 'on Tuesday for my family and the Lamborghini on Sunday". The facts in this call are '
    + 'then recorded against that car\'s own booking, with its own dates and its own price. '
    + 'Do NOT use it when they change their mind or narrow down ("actually the Ferrari", "no, '
    + 'the yellow one") — that is one booking whose car changed, and naming it here would '
    + 'leave a second booking for a car they turned down. When they want two cars, make one '
    + 'call per car.',
  ),
})

export const requestHandoffSchema = z.strictObject({
  reason: z.string().min(1).max(500)
    .describe('Why a person is needed. One sentence, for the salesperson who picks this up.'),
})

export const extendBookingSchema = z.strictObject({
  newEndDate: z.string().describe(
    'The new last day of the rental, inclusive, as YYYY-MM-DD resolved against the operator\'s '
    + 'today. Not the number of extra days and not a phrase — "two more days" on a rental '
    + 'ending on the 27th is 2026-09-29. It must be later than the day their rental currently '
    + 'ends; anything else is a change of dates rather than an extension and needs a person.',
  ),
})

export const recordBookingProgressSchema = z.strictObject({
  handover: z.enum(['delivery', 'collection']).nullable().describe(
    'Whether they want the car delivered or will collect it, the moment they say — "I\'ll '
    + 'collect it", "bring it to me", a tapped Delivery or Collection. Null unless they said in '
    + 'this message. Changing it is fine; a time given for the other one is dropped.',
  ),
  deliveryAddress: z.string().min(3).nullable().describe(
    'The full address the car goes to, as they gave it — building, flat or villa, area. Null '
    + 'unless they gave one in this message. A P.O. Box is not an address a car can be handed '
    + 'over at: leave this null and ask for the building or villa and the area instead.',
  ),
  deliveryTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).nullable().describe(
    'The time on the first day the car is handed over — delivered to them, or collected by them '
    + '— 24-hour HH:MM. "10am" is 10:00, "half two in the afternoon" is '
    + '14:30. Null unless they gave one. If they gave a range, use the start of it.',
  ),
  paymentPlan: z.enum(['transfer', 'link', 'on_delivery']).nullable().describe(
    'How they said they will pay: bank transfer, the payment link, or card or cash at the '
    + 'handover. Null unless they said. on_delivery only when they said they will pay when the car '
    + 'is handed over — "card" alone, or asking you to send the details, is not that: ask, or leave '
    + 'it null.',
  ),
  saysPaid: z.boolean().nullable().describe(
    'True only when they say they have already paid, or send a transfer screenshot. A person '
    + 'checks the account; this only records that they said so.',
  ),
})

export const requestBookingReviewSchema = z.strictObject({
  quoteId: z.string().describe(
    'The quote the customer wants to proceed with, as returned by prepare_quote. It must be '
    + 'the quote for the car they are agreeing to and the current one — an older price, or one '
    + 'belonging to their other rental, is refused rather than recorded.',
  ),
})

/**
 * Every tool, in one place.
 *
 * The dispatcher reads this map and nothing else, so a tool that is not listed
 * here cannot be called. That is what makes "no refunds, no arbitrary URLs, no
 * booking confirmation" enforceable rather than aspirational — those tools are
 * not omitted from a list of allowed names, they have no implementation to
 * reach.
 */
export const TOOL_SCHEMAS = {
  get_operator_policy: getOperatorPolicySchema,
  search_vehicles: searchVehiclesSchema,
  prepare_quote: prepareQuoteSchema,
  record_enquiry_fields: recordEnquiryFieldsSchema,
  request_handoff: requestHandoffSchema,
  request_booking_review: requestBookingReviewSchema,
  extend_booking: extendBookingSchema,
  record_booking_progress: recordBookingProgressSchema,
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[]

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(TOOL_SCHEMAS, value)
}

const DESCRIPTIONS: Record<ToolName, string> = {
  get_operator_policy:
    'Look up this operator\'s approved answer on a policy topic. Returns nothing if they have not published one — say you will check rather than guessing.',
  search_vehicles:
    'Look up this operator\'s cars: what they are, and the day rate a person at the operator confirmed. ' +
    'Call this for any question about what cars exist, what they are like, or what they cost — including ' +
    '"what is your most expensive car". Dates are optional and are only needed to check availability; ' +
    'without them you still get the fleet and the rates, dearest first.',
  prepare_quote:
    'Work out the full price for the dates on this enquiry: total, deposit and the breakdown, ' +
    'calculated from the confirmed rate. Returns figures you may state. Does not send anything to the customer.',
  record_enquiry_fields:
    'Save facts the customer has stated. Call this as soon as they say something, not at the end. '
    + 'Dates must arrive resolved as YYYY-MM-DD: nothing downstream can price an enquiry whose dates '
    + 'were never recorded, so a rejected date is a quote the customer never gets.',
  request_handoff:
    'Hand this conversation to a person. Stops automated replies immediately.',
  record_booking_progress:
    'Save what they told you about a confirmed booking: the delivery address, the delivery '
    + 'time, how they will pay, or that they have paid. Call it as soon as they say any of it. '
    + 'It only fills in what they gave, so call it again for each new piece.',
  extend_booking:
    'Keep the car they already have for longer. Use this when somebody with a confirmed rental '
    + 'asks to keep it — it checks the car is free for the extra days, prices them at the '
    + 'operator\'s own rates and, where the operator allows it, settles it on the spot. It '
    + 'refuses if the car is promised to somebody else, and tells you until when. Not for '
    + 'changing the dates of a rental that has not started, and not for a second car.',
  /**
   * Deliberately says nothing about who confirms.
   *
   * It used to end "say that you are passing it to a colleague to confirm",
   * which was true of every operator when it was written. A description is
   * read on every turn whatever the operator has switched on, so for one who
   * lets the agent settle bookings it was a standing instruction to offer the
   * team — "Shall I send it to the team for confirmation?" — before the
   * customer had even said yes, and to promise a person afterwards. Whether
   * it is confirmed is decided by the record and arrives in the result, which
   * already says exactly what may be said.
   */
  request_booking_review:
    'Book it for them. Call this the moment they say yes to a price — in any words, any '
    + 'language, a typo included. The result says whether it is CONFIRMED or waiting on a '
    + 'colleague, and what you may tell them; say that and nothing more. Never describe it as '
    + 'booked, confirmed or held unless the result says it is.',
}

/**
 * The tool list as a provider sends it to a model.
 *
 * Provider-neutral on purpose: the model has not been chosen yet (section 18.8
 * asks for that decision to follow an evaluation, not precede it), and every
 * major provider takes a name, a description and a JSON Schema. Adapting this
 * shape to a specific SDK is a few lines at the call site.
 */
export type ToolDefinition = {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

export function toolDefinitions(): ToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: z.toJSONSchema(TOOL_SCHEMAS[name], { target: 'draft-2020-12' }) as Record<string, unknown>,
  }))
}
