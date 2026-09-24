import { activeBookingFor, addToBooking, formatMoneyMinor } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { addToBookingSchema } from './schemas.js'
import type { z } from 'zod'

export type AddOnAdded = { added: string; price: string; owed: string; guidance: string }

/**
 * An extra on their booking, when they ask for it.
 *
 * Which booking is found, never passed, and the price is the operator's list:
 * the model says which add-on and nothing else.
 */
export async function addToBookingTool(
  ctx: ToolContext,
  args: z.infer<typeof addToBookingSchema>,
): Promise<ToolResult<AddOnAdded>> {
  const bookingId = await activeBookingFor(ctx.run, { operatorId: ctx.operatorId, conversationId: ctx.conversationId })
  if (bookingId === null) {
    return refuse('nothing_to_do', 'They have no confirmed booking to add it to. Book the car first.')
  }
  const result = await addToBooking(ctx.transact, { operatorId: ctx.operatorId, bookingId, addOnId: args.addOnId })
  if (!result.ok) {
    return refuse(result.reason === 'unknown' ? 'invalid_arguments' : 'nothing_to_do', result.detail)
  }
  const money = (minor: number) => formatMoneyMinor(minor, result.currency)
  return ok({
    added: result.label,
    price: money(result.amountMinor),
    owed: money(result.owedMinor),
    guidance: `Added: ${result.label}, ${money(result.amountMinor)}. Say so in one line with the new amount `
      + `due, ${money(result.owedMinor)}, and carry on with whatever the booking still needs.`,
  })
}
