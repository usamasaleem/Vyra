import { calculateDraftQuote, getEnquiryFields } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { prepareQuoteSchema } from './schemas.js'
import type { z } from 'zod'

/**
 * Note what is absent: every number.
 *
 * The agent learns that a quote exists and is waiting for a person, not what it
 * says. Section 18.9 gives Operations the calculation and forbids Sales turning
 * an estimate into a booking; section 18.8 says material commercial amounts are
 * rendered from validated database fields rather than phrased by a model.
 *
 * Withholding the figures is stronger than instructing the model not to repeat
 * them. A model cannot leak a number it was never given, and every rule about
 * what it must not say is a rule it might not follow.
 */
export type QuoteRequested = {
  quoteRequested: true
  /** So a salesperson and the agent are talking about the same draft. */
  revision: number
  days: number
  /** What the agent may tell the customer while they wait. */
  guidance: string
}

/**
 * Mandatory check (section 18.8): versioned inputs, and no automatic discount.
 *
 * The scope check is implemented and runs first, because it is the one that
 * could leak. The model is given an enquiry id to pass back, and a model that
 * has confused two conversations — or been told to by a customer message
 * saying "quote enquiry 7 instead" — would pass a different one. Comparing it
 * against the enquiry the worker loaded turns that into a refusal rather than
 * another customer's rates.
 *
 * That comparison is cheap and might look redundant, since the enquiry id could
 * simply be taken from `ctx` and the argument dropped. It is kept deliberately:
 * section 18.8 requires treating retrieved text and customer messages as
 * untrusted input, and a tool that silently ignores a wrong argument cannot
 * report that the model asked for the wrong thing. A refusal here is a signal
 * worth having in the pilot.
 *
 * Calculation itself needs approved rate inputs, which arrive with Operations
 * in build plan step 30. Until then this refuses rather than estimating.
 * Section 18.9 puts the boundary in the same place for people: Sales may
 * *request* a draft quote, and Operations owns the calculation. The AI does not
 * get an authority that a salesperson does not have.
 *
 * "No automatic discount" is a property of that future calculation, and it is
 * worth recording now where it belongs: there is no discount argument in this
 * tool's schema, so a discount cannot arrive through this path at all. Pricing
 * exceptions are a manager approval (section 18.7), not a model decision.
 */
export async function prepareQuote(
  ctx: ToolContext,
  args: z.infer<typeof prepareQuoteSchema>,
): Promise<ToolResult<QuoteRequested>> {
  if (args.enquiryId !== ctx.enquiryId) {
    return refuse(
      'wrong_scope',
      'That enquiry is not the one under discussion in this conversation. Quote only the current enquiry.',
    )
  }

  /**
   * Dates and vehicle come from the enquiry, not from the model.
   *
   * A quote is priced on what the customer actually said and a salesperson can
   * check, and the evidence for each is already recorded with its source
   * message. Letting the model pass them would make the priced dates a thing it
   * asserted rather than a thing the customer said.
   */
  const fields = await getEnquiryFields(ctx.run, ctx.operatorId, ctx.enquiryId)
  const value = (name: string) => fields.find((f) => f.field === name)?.value ?? null

  const vehicleRows = await ctx.run(
    `select id from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'
       and (make || ' ' || model || ' ' || coalesce(variant, '')) ilike '%' || $2 || '%'
     limit 2`,
    [ctx.operatorId, value('vehicle') ?? ''],
  )
  if (vehicleRows.length !== 1) {
    return refuse(
      'nothing_to_do',
      vehicleRows.length === 0
        ? 'No single confirmed vehicle matches this enquiry yet. Confirm which car before asking for a price.'
        : 'More than one vehicle matches. Ask the customer which one before requesting a price.',
    )
  }

  const result = await calculateDraftQuote(ctx.run, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
    enquiryId: ctx.enquiryId,
    vehicleId: vehicleRows[0]!['id'] as string,
    startDate: value('start_at'),
    endDate: value('end_at'),
  })

  if (!result.ok) {
    return refuse(
      result.refusal.reason === 'no_confirmed_rate' ? 'no_trusted_source' : 'invalid_arguments',
      result.refusal.detail,
      result.refusal.reason === 'no_confirmed_rate'
        ? 'set a confirmed rate for this vehicle so it can be priced'
        : undefined,
    )
  }

  return ok(
    {
      quoteRequested: true,
      revision: result.quote.revision,
      days: result.quote.days,
      guidance:
        'A draft quote has been prepared and is waiting for a salesperson to approve. You have NOT been told the price and must not state, estimate or hint at any figure. Tell the customer the quote is being prepared and will come through shortly.',
    },
    'approve or reject a draft quote',
  )
}
