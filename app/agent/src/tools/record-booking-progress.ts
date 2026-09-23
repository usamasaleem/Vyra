import { activeBookingFor, bookingChecklist, recordBookingProgress } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { recordBookingProgressSchema } from './schemas.js'
import type { z } from 'zod'

export type BookingProgress = {
  /** What is still to collect, in the order worth asking. */
  stillNeeded: string[]
  guidance: string
}

const ASK: Record<string, string> = {
  delivery_address: 'the address the car should go to',
  delivery_time: 'what time on the first day they want it',
  documents: 'a photo of their driving licence and of their passport or Emirates ID',
  payment: 'how they would like to pay',
}

/**
 * Where the booking goes after "Booked".
 *
 * Which booking is found here, never passed: it is the confirmed rental in
 * this conversation that has not happened yet. The agent only contributes
 * what the customer said, which is the one thing it reads better than a query.
 */
export async function recordBookingProgressTool(
  ctx: ToolContext,
  args: z.infer<typeof recordBookingProgressSchema>,
): Promise<ToolResult<BookingProgress>> {
  const bookingId = await activeBookingFor(ctx.run, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
  })
  if (bookingId === null) {
    return refuse(
      'nothing_to_do',
      'They have no confirmed booking to add this to. If they are booking, confirm that first.',
    )
  }

  await recordBookingProgress(ctx.run, {
    operatorId: ctx.operatorId,
    bookingId,
    deliveryAddress: args.deliveryAddress,
    deliveryTime: args.deliveryTime,
    paymentPlan: args.paymentPlan,
    saysPaid: args.saysPaid === true,
  })

  const list = await bookingChecklist(ctx.run, { operatorId: ctx.operatorId, bookingId })
  const missing = list?.missing ?? []

  return ok({
    stillNeeded: missing.map((m) => ASK[m] ?? m),
    guidance: missing.length === 0
      ? 'Everything is in. Thank them, say the team checks the documents and the payment before '
        + 'delivery, and stop — do not ask for anything else.'
      : `Acknowledge what they gave in a few words, then ask for ${ASK[missing[0]!]}. One thing `
        + 'at a time.',
  })
}
