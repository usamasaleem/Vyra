import { requestBooking } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { requestBookingReviewSchema } from './schemas.js'
import type { z } from 'zod'

export type BookingReviewRequested = {
  bookingId: string
  quoteId: string
  /** True when this yes was already on file. Say so; do not ask them again. */
  alreadyRequested: boolean
  /** Whether it is booked, or waiting on a person. Decided by the record. */
  confirmed: boolean
  guidance: string
}

/**
 * Mandatory check (section 18.8): the quote belongs to this enquiry, and it is
 * the current revision.
 *
 * Both halves guard a different mistake. Ownership stops a quote id from
 * another enquiry being approved into this one — with two rentals in a thread
 * that is an ordinary Tuesday, not a hypothetical. Currency stops a superseded
 * revision being approved: a customer who says "yes, the 4,500 one" after the
 * rate changed is agreeing to terms that no longer exist, and recording that
 * would put the operator in front of somebody holding them to a price they had
 * already withdrawn. Both are checked in the query, against the row, not here
 * against an argument.
 *
 * The name is the important part of this tool. It creates an approval task; it
 * does not confirm a booking. Section 18.8 lists final booking confirmation
 * alongside refunds and payment verification as things that are not AI tools at
 * all, and section 18.13 keeps the same line for payments: a successful payment
 * never automatically establishes availability or a confirmed booking. Staff
 * retain that authority. So the most a model can do with a customer saying
 * "yes, book it" is put it in front of a person — which, until now, it could
 * not do either: this refused every call it ever received, and the bottom of
 * the funnel was a handoff with no figures attached to it.
 */
export async function requestBookingReview(
  ctx: ToolContext,
  args: z.infer<typeof requestBookingReviewSchema>,
): Promise<ToolResult<BookingReviewRequested>> {
  const result = await requestBooking(ctx.transact, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
    enquiryId: ctx.enquiryId,
    quoteId: args.quoteId,
    sourceMessageId: ctx.messageId,
    now: ctx.now,
  })

  if (!result.ok) {
    /**
     * The refusal carries what to do instead, because a model told only that
     * something failed says so to the customer. These reach the reply as the
     * reason it cannot go further, and each one has a different next step.
     */
    return refuse('invalid_arguments', result.refusal.detail)
  }

  /**
   * What the customer may be told, decided here rather than by the model.
   *
   * The difference between "booked" and "a colleague will confirm" is the
   * difference between a promise the operator must keep and one nobody made.
   * It turns on whether the car was actually held, which is a fact about the
   * record, so it is stated as one — not left to an instruction the model
   * weighs against everything else it has been told.
   */
  return ok({
    bookingId: result.booking.bookingId,
    quoteId: result.booking.quoteId,
    alreadyRequested: result.booking.alreadyRequested,
    confirmed: result.booking.confirmed,
    guidance: result.booking.confirmed
      ? 'This is CONFIRMED. The car is held for those dates and nobody else can be given '
        + 'it. Tell them plainly that it is booked, say the car and the dates back once, and '
        + 'say somebody will be in touch about the details. Do not say it is pending or that '
        + 'a colleague still has to approve it.'
      : 'This is NOT confirmed. Their agreement is recorded and a colleague will confirm it. '
        + 'Say that, and do not say it is booked, held, reserved or secured.',
  })
}
