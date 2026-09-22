import { extendableBooking, extendBooking, formatMoneyMinor } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { extendBookingSchema } from './schemas.js'
import type { z } from 'zod'

export type BookingExtended = {
  extraDays: number
  extra: string
  until: string
  confirmed: boolean
  guidance: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Keeping the car longer, which is the most common thing a customer asks for
 * once they have it and the one thing the agent could never do.
 *
 * Which booking is not the model's to choose. It is the confirmed rental in
 * this conversation, found here — a model handed a booking id would sooner or
 * later extend the wrong one, and there is no sentence a customer can write
 * that makes the answer ambiguous to a query.
 *
 * The dates come from the customer and the price comes from the operator's
 * table, the same division as everywhere else. What the model contributes is
 * resolving "two more days" against a calendar, which is the one part of this
 * it is better at than a regular expression.
 */
export async function extendBookingTool(
  ctx: ToolContext,
  args: z.infer<typeof extendBookingSchema>,
): Promise<ToolResult<BookingExtended>> {
  if (!ISO_DATE.test(args.newEndDate)) {
    return refuse(
      'invalid_arguments',
      `"${args.newEndDate}" is not a resolved date. Work out which calendar day they mean and `
      + 'pass it as YYYY-MM-DD.',
    )
  }

  const current = await extendableBooking(ctx.run, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
  })
  if (current === null) {
    return refuse(
      'nothing_to_do',
      'They have no confirmed rental in this conversation, so there is nothing to extend. If '
      + 'they are trying to book, do that instead.',
    )
  }

  const result = await extendBooking(ctx.transact, {
    operatorId: ctx.operatorId,
    bookingId: current.bookingId,
    newEndDate: args.newEndDate,
    membershipId: null,
    now: ctx.now,
  })

  if (!result.ok) {
    return refuse('invalid_arguments', result.refusal.detail)
  }

  const { extension } = result
  const extra = formatMoneyMinor(extension.extraMinor, extension.currency)

  return ok({
    extraDays: extension.extraDays,
    extra,
    until: extension.toDate,
    confirmed: extension.confirmed,
    /**
     * What may be said, decided by the record rather than by the model's
     * reading of its own instructions — the same division as a first booking.
     */
    guidance: extension.confirmed
      ? `The extension is CONFIRMED and the car is held to ${extension.toDate}. Tell them `
        + `plainly that they can keep it, say until when and what the extra days cost `
        + `(${extra}), and stop. Do not re-quote the original rental.`
      : `This is NOT confirmed. The extra days are recorded and a colleague will settle them. `
        + `Say that, give the figure for the extra days (${extra}), and do not say the car is `
        + 'held or that the extension is agreed.',
  })
}
