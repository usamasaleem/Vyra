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
      value: z.string().min(1).describe('The normalised value.'),
      originalWording: z.string().nullable()
        .describe('What the customer actually typed, if it differs from the value.'),
    }),
  ).min(1).describe('Facts the customer stated in this conversation.'),
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
    'Save facts the customer has stated. Call this as soon as they say something, not at the end.',
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
