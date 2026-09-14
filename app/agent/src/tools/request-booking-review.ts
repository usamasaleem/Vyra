import type { ToolContext } from './context.js'
import { refuse, type ToolResult } from './result.js'
import type { requestBookingReviewSchema } from './schemas.js'
import type { z } from 'zod'

export type BookingReviewRequested = {
  taskId: string
  quoteId: string
  quoteRevision: number
}

/**
 * Mandatory check (section 18.8): the quote belongs to this enquiry, and it is
 * the current revision.
 *
 * Neither can run yet — quotes arrive with Operations in build plan step 30 —
 * so this refuses. The shape of the check is worth fixing now, because both
 * halves guard a different mistake. Ownership stops a quote id from another
 * enquiry being approved into this one. Currency stops a superseded revision
 * being approved: a customer who says "yes, the 4,500 one" after the rate
 * changed is agreeing to terms that no longer exist, and approving the
 * superseded revision would bind the operator to them.
 *
 * The name is the important part of this tool. It creates an approval task; it
 * does not confirm a booking. Section 18.8 lists final booking confirmation
 * alongside refunds and payment verification as things that are not AI tools at
 * all, and section 18.13 keeps the same line for payments: a successful payment
 * never automatically establishes availability or a confirmed booking. Staff
 * retain that authority in Vyra's initial scope. So the most a model can do
 * with a customer saying "yes, book it" is put it in front of a person.
 */
export async function requestBookingReview(
  ctx: ToolContext,
  args: z.infer<typeof requestBookingReviewSchema>,
): Promise<ToolResult<BookingReviewRequested>> {
  void args
  void ctx
  return refuse(
    'not_available_yet',
    'Booking review is not connected yet. Request a handoff so a person can take the booking, and do not tell the customer anything is confirmed.',
    'take this booking — booking review is not connected',
  )
}
