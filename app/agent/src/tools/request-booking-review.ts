import { ASK_FOR, bookingChecklist, formatMoneyMinor, holdCar, requestBooking } from '@vyra/db'
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
  /**
   * What happens next, read from the booking rather than left to the model.
   *
   * Live, the confirmation ended "Someone will be in touch about the
   * details" — because this guidance told it to say exactly that. It sent the
   * customer off to wait at the one moment the agent was about to carry on
   * itself: the time, the documents and the money are all its to collect.
   */
  const next = result.booking.confirmed
    ? await bookingChecklist(ctx.run, {
      operatorId: ctx.operatorId,
      bookingId: result.booking.bookingId,
    }).catch(() => null)
    : null
  const owed = next === null || next.owedMinor === 0
    ? null
    : formatMoneyMinor(next.owedMinor, next.currency)
  const first = next?.missing[0]
  /**
   * The extras, said once, here — the moment the booking lands. Asked for in
   * the instructions, the line never appeared in simulation; said by the tool
   * that confirms, it is part of the confirming.
   */
  const extras = !result.booking.confirmed || result.booking.alreadyRequested
    ? []
    : await ctx.run(`select add_ons from operators where id = $1`, [ctx.operatorId])
      .then((rows) => (rows[0]?.['add_ons'] as Array<{ name: string; priceMinor: number; per: string }> | null) ?? [])
      .catch(() => [])
  const extrasLine = extras.length === 0 || next === null
    ? ''
    : 'Also add one short line, not a question, offering the extras: '
      + extras.map((a) => `${a.name.toLowerCase()} (${formatMoneyMinor(a.priceMinor, next.currency)}${a.per === 'day' ? ' a day' : ''})`).join(' or ')
      + ' — e.g. "If you\'d like a chauffeur or extra kilometres, just say." Once only. '
  const carryOn = (owed === null ? '' : `Say that ${owed} is due in total, rental and refundable deposit together. `)
    + (first === undefined
      ? ''
      : `Then ask ONE question. If you were given what they need to bring and do not yet know whether `
        + `they live in the UAE or are visiting, ask that; otherwise ask for ${ASK_FOR[first]}. `)
    + 'You are handling the rest yourself: never say somebody will be in touch, contact them or '
    + 'follow up with the details. '
    + extrasLine

  /**
   * Over the operator's limits — a long rental, a large total — a person
   * confirms it. The car should not be lost while they do, so it is held on
   * the same terms as any customer deciding.
   */
  const waits = result.booking.waitsBecause
  const heldWhileWaiting = waits === undefined || result.booking.confirmed
    ? null
    : await holdCar(ctx.transact, {
      operatorId: ctx.operatorId, conversationId: ctx.conversationId, quoteId: args.quoteId, now: ctx.now,
    }).catch(() => null)
  const heldUntil = heldWhileWaiting?.ok === true
    ? new Intl.DateTimeFormat('en-GB', {
      timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(heldWhileWaiting.until)
    : null
  const waitingNote = waits === undefined
    ? ''
    : `This one waits for a colleague because it is ${waits === 'too_long' ? 'a longer rental' : 'a larger booking'} `
      + 'than the agent confirms on its own — say that plainly, as ordinary, not as a problem. '
      + (heldUntil === null
        ? ''
        : `The car is held for them until ${heldUntil} while they confirm it, so nobody else can take it; say so. `)

  return ok({
    bookingId: result.booking.bookingId,
    quoteId: result.booking.quoteId,
    alreadyRequested: result.booking.alreadyRequested,
    confirmed: result.booking.confirmed,
    guidance: result.booking.alreadyRequested && result.booking.confirmed
      ? 'They ALREADY have this booked — the car is held for them and was before this message. '
        + 'Say so as a reminder rather than as news, and do not imply anything has just changed '
        + 'or that a colleague is still to do something. If they are asking because they never '
        + 'heard back, apologise briefly for that and confirm the details.'
      : result.booking.confirmed
      ? 'This is CONFIRMED. The car is held for those dates and nobody else can be given '
        + 'it. Your reply opens with "Booked" — they must be able to see it is done — and says '
        + 'the car and the dates back once. If they already told you the address, the time or '
        + 'whether they are collecting, save it now with record_booking_progress rather than '
        + 'asking again. '
        + carryOn
        + 'Do not say it is pending or that a colleague still has to approve it.'
      : waits !== undefined
        ? 'This is NOT confirmed yet. Their agreement is recorded and a colleague will confirm it. '
          + waitingNote + 'Do not say it is booked or confirmed.'
        : 'This is NOT confirmed. Their agreement is recorded and a colleague will confirm it. '
          + 'Say that, and do not say it is booked, held, reserved or secured.',
  })
}
