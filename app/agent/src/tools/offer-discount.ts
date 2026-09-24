import { applyStandingDiscount, formatMoneyMinor } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { offerDiscountSchema } from './schemas.js'
import type { z } from 'zod'

export type DiscountOffered = {
  quoteId: string
  total: string
  saving: string
  deposit: string | null
  guidance: string
}

/**
 * The operator's standing offer, when the price is the objection.
 *
 * The figures come back formatted, and the new quoteId with them: booking the
 * old price after offering a lower one would charge the customer what they
 * were just told they would not pay.
 */
export async function offerDiscount(
  ctx: ToolContext,
  args: z.infer<typeof offerDiscountSchema>,
): Promise<ToolResult<DiscountOffered>> {
  const result = await applyStandingDiscount(ctx.transact, {
    operatorId: ctx.operatorId, conversationId: ctx.conversationId, quoteId: args.quoteId,
  })
  if (!result.ok) {
    const next = result.nextTier === undefined
      ? ''
      : ` If a longer rental would suit them, you may say "we take ${result.nextTier.percent}% off `
        + `rentals of ${result.nextTier.minDays} days or more" — once, as an option, not a push.`
    return refuse(
      result.reason === 'no_quote' ? 'invalid_arguments' : 'nothing_to_do',
      `${result.detail} Do not invent or promise any money off, and speak as "we" — never "the `
        + `operator".${next} Otherwise offer a car that `
        + 'costs less and is available on the same dates (search_vehicles with the dates) — say what '
        + 'it is and what it costs.',
    )
  }
  const money = (minor: number) => formatMoneyMinor(minor, result.currency)
  return ok({
    quoteId: result.quoteId,
    total: money(result.totalMinor),
    saving: money(result.discountMinor),
    deposit: result.depositMinor === null ? null : money(result.depositMinor),
    guidance: `Applied: ${result.percent}% off, which we give on rentals of ${result.minDays}+ days. `
      + `Give them the new total in one short line, warmly, and offer to book or hold it at that price. `
      + `If they book, pass THIS quoteId (${result.quoteId}), not the old one. This is the best the `
      + 'agent can do: if they want more off, a colleague decides — say so, and do not promise it.',
  })
}
