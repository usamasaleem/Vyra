import type { ToolContext } from './context.js'
import { refuse, type ToolResult } from './result.js'
import type { prepareQuoteSchema } from './schemas.js'
import type { z } from 'zod'

export type QuoteDraft = {
  quoteId: string
  revision: number
  lines: Array<{ description: string; amount: string }>
  total: string
  currency: string
  validUntil: string
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
): Promise<ToolResult<QuoteDraft>> {
  if (args.enquiryId !== ctx.enquiryId) {
    return refuse(
      'wrong_scope',
      'That enquiry is not the one under discussion in this conversation. Quote only the current enquiry.',
    )
  }

  return refuse(
    'not_available_yet',
    'Quote calculation is not connected yet — approved rates come from Operations. Ask for a handoff so a person can price this, and do not state any figure.',
  )
}
