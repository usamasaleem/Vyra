import type { ToolContext } from './context.js'
import { refuse, type RefusalReason, type ToolResult } from './result.js'
import { TOOL_SCHEMAS, isToolName, toolDefinitions, type ToolDefinition, type ToolName } from './schemas.js'
import { getOperatorPolicy } from './get-operator-policy.js'
import { searchVehicles } from './search-vehicles.js'
import { prepareQuote } from './prepare-quote.js'
import { recordEnquiryFields } from './record-enquiry-fields.js'
import { requestHandoff } from './request-handoff.js'
import { requestBookingReview } from './request-booking-review.js'

/**
 * Build plan step 24 — the boundary itself.
 *
 * Everything a model is able to do to this system passes through `call`. That
 * is the property worth protecting: not that the six tools are individually
 * careful, but that there is no seventh path. Section 18.8's closing
 * instruction — "Do not expose unrestricted SQL, arbitrary URLs, refunds,
 * payment verification or final booking confirmation as general AI tools" —
 * is enforced by this file having a fixed map and no escape hatch, rather than
 * by a deny-list someone has to remember to extend.
 *
 * The model supplies two things: a name and a JSON blob. Both are untrusted.
 * A name that is not in the map is refused, not thrown — a model that
 * hallucinates `issue_refund` should produce a countable refusal, because how
 * often that happens is something the pilot needs to know.
 */

const IMPLEMENTATIONS: {
  [K in ToolName]: (ctx: ToolContext, args: never) => Promise<ToolResult<unknown>>
} = {
  get_operator_policy: getOperatorPolicy,
  search_vehicles: searchVehicles,
  prepare_quote: prepareQuote,
  record_enquiry_fields: recordEnquiryFields,
  request_handoff: requestHandoff,
  request_booking_review: requestBookingReview,
}

export type ToolCallRecord = {
  /** As the model asked for it, including a name that does not exist. */
  requestedName: string
  status: 'ok' | 'refused'
  reason: RefusalReason | null
  durationMs: number
}

export type BoundaryOptions = {
  /**
   * Section 18.8 asks for a maximum tool call count. Eight is enough for a
   * real turn — record what the customer said, look up a policy or two, ask
   * for a handoff — and low enough that a model looping on a refusal stops
   * being the system's problem within a few seconds.
   */
  maxCalls?: number
  /** Wall-clock limit for the whole turn. Checked before each call, never mid-call. */
  deadline?: Date
  /** Injectable so the budget is testable without waiting. */
  clock?: () => number
}

export type ToolBoundary = {
  /** The tool list to hand a provider. */
  definitions: ToolDefinition[]
  call: (name: string, rawArguments: unknown) => Promise<ToolResult<unknown>>
  /** Every attempt, in order, including refusals. Belongs in the agent run record. */
  history: readonly ToolCallRecord[]
  callsRemaining: () => number
}

export function createToolBoundary(ctx: ToolContext, options: BoundaryOptions = {}): ToolBoundary {
  const maxCalls = options.maxCalls ?? 8
  const clock = options.clock ?? (() => Date.now())
  const deadline = options.deadline ?? null
  const history: ToolCallRecord[] = []

  async function call(name: string, rawArguments: unknown): Promise<ToolResult<unknown>> {
    const started = clock()

    const record = (result: ToolResult<unknown>): ToolResult<unknown> => {
      history.push({
        requestedName: name,
        status: result.status,
        reason: result.status === 'refused' ? result.reason : null,
        durationMs: clock() - started,
      })
      return result
    }

    // The budget is checked before the name, so an exhausted turn cannot be
    // extended by asking for tools that do not exist. Refusals count against
    // it too: a model retrying a refused call is exactly the loop this bounds.
    if (history.length >= maxCalls) {
      return record(refuse('budget_exhausted', `No tool calls left this turn (limit ${maxCalls}).`))
    }
    if (deadline !== null && started > deadline.getTime()) {
      return record(refuse('budget_exhausted', 'This turn ran out of time.'))
    }

    if (!isToolName(name)) {
      return record(refuse('unknown_tool', `There is no tool called "${name}".`))
    }

    const parsed = TOOL_SCHEMAS[name].safeParse(rawArguments)
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      return record(refuse('invalid_arguments', `${name} arguments were rejected — ${problems}`))
    }

    try {
      return record(await IMPLEMENTATIONS[name](ctx, parsed.data as never))
    } catch (error) {
      // An infrastructure failure is not a refusal and must not be disguised as
      // one. It is recorded so the turn's history is complete, then rethrown
      // for the worker's failure handling (build plan step 28) to turn into a
      // visible human task rather than silence.
      history.push({
        requestedName: name,
        status: 'refused',
        reason: null,
        durationMs: clock() - started,
      })
      throw error
    }
  }

  return {
    definitions: toolDefinitions(),
    call,
    get history() {
      return history
    },
    callsRemaining: () => Math.max(0, maxCalls - history.length),
  }
}
