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

export const requestBookingReviewSchema = z.strictObject({
  quoteId: z.string().describe('The quote the customer wants to proceed with.'),
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
  request_booking_review:
    'Ask a person to review a quote the customer wants to accept. Does not confirm a booking.',
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
