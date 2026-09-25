import {
  cancelForCustomer, changeableBooking, formatMoneyMinor, getApprovedAnswer, moveBookingDates, recordFields,
} from '@vyra/db'
import type { z } from 'zod'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { cancelBookingSchema, changeBookingDatesSchema } from './schemas.js'

/**
 * Cancelling and moving a booking, at the customer's word.
 *
 * Both ask before they act. The first call changes nothing and returns what
 * the change would mean — the policy, the new price — for the agent to put to
 * the customer; the second, on their yes, does it. A yes is only accepted when
 * the agent's last message actually asked it: a customer who said "cancel?"
 * as a question is not cancelled because a model read it as an answer.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

async function lastQuestion(ctx: ToolContext): Promise<string> {
  const [row] = await ctx.run(
    `select body from messages
     where conversation_id = $1 and operator_id = $2 and direction = 'outbound' and body is not null
     order by created_at desc limit 1`,
    [ctx.conversationId, ctx.operatorId],
  )
  return (row?.['body'] as string) ?? ''
}

export type CancelOutcome = { cancelled: boolean; guidance: string; policy: string | null }

export async function cancelBookingTool(
  ctx: ToolContext,
  args: z.infer<typeof cancelBookingSchema>,
): Promise<ToolResult<CancelOutcome>> {
  const booking = await changeableBooking(ctx.run, { operatorId: ctx.operatorId, conversationId: ctx.conversationId, now: ctx.now })
  if (booking === null) return refuse('nothing_to_do', 'There is no booking in this conversation to cancel.')
  if (booking.started) {
    return refuse('nothing_to_do', 'The rental has already started, so it cannot be cancelled here. Ask whether they want to bring the car back early, and hand that to a colleague.',
      `Customer with a rental in progress (${booking.vehicle ?? 'car'}) wants to cancel or end it early.`)
  }
  const policy = (await getApprovedAnswer(ctx.run, ctx.operatorId, 'cancellation', ctx.now))?.answer ?? null
  const money = (minor: number) => formatMoneyMinor(minor, booking.currency)
  // Both units: a policy that turns on 48 hours is decided by the hours, not the days.
  const days = Math.floor(booking.hoursToHandover / 24)
  const hours = booking.hoursToHandover % 24
  const when = days === 0 ? `${hours} hours`
    : `${days} day${days === 1 ? '' : 's'}${hours === 0 ? '' : ` and ${hours} hour${hours === 1 ? '' : 's'}`}`
  const facts = `The ${booking.vehicle ?? 'car'} is booked from ${booking.startDate} to ${booking.endDate}, `
    + `${when} from now. They have paid ${booking.paidMinor === 0 ? 'nothing yet' : money(booking.paidMinor)}.`

  if (!args.customerConfirmed) {
    return ok({
      cancelled: false,
      policy,
      guidance: `NOTHING HAS BEEN CANCELLED. ${facts} `
        + (policy === null
          ? 'There is no published cancellation policy, so do not say what happens to their money: say a colleague will confirm that. '
          : 'Tell them, in a sentence or two and in the policy\'s own terms, what cancelling now means for them. ')
        + 'Then ask "Shall I cancel it?" and nothing else.',
    })
  }

  if (!/cancel/i.test(await lastQuestion(ctx))) {
    return refuse('invalid_arguments', 'You have not asked them whether to cancel yet. Call again with customerConfirmed false and ask first.')
  }
  const result = await cancelForCustomer(ctx.transact, { operatorId: ctx.operatorId, conversationId: ctx.conversationId, now: ctx.now })
  if (result.cancelled === 0) return refuse('nothing_to_do', 'There was nothing left to cancel.')
  const paid = result.paidMinor > 0
  return ok(
    {
      cancelled: true,
      policy,
      guidance: `CANCELLED: the booking is cancelled and the car released. Say so plainly. `
        + (paid
          ? `They had paid ${money(result.paidMinor)}. Say what the cancellation policy means for it, and that the team will `
            + 'process any refund — do not say it has been refunded, and do not promise a date the policy does not give.'
          : 'Nothing had been paid, so nothing is owed either way.')
        + ' Keep it warm, and leave the door open for another time.',
    },
    paid
      ? `Cancelled by the customer ${when} before the handover. They had paid ${money(result.paidMinor)}: refund what the cancellation policy says.`
      : undefined,
  )
}

export type DatesChanged = {
  applied: boolean
  total: string
  difference: string | null
  guidance: string
}

export async function changeBookingDatesTool(
  ctx: ToolContext,
  args: z.infer<typeof changeBookingDatesSchema>,
): Promise<ToolResult<DatesChanged>> {
  if (!ISO_DATE.test(args.newStartDate) || !ISO_DATE.test(args.newEndDate)) {
    return refuse('invalid_arguments', 'Pass both dates resolved, as YYYY-MM-DD.')
  }
  if (args.newEndDate < args.newStartDate) {
    return refuse('invalid_arguments', `The last day ${args.newEndDate} is before the first day ${args.newStartDate}. Check the dates with them.`)
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone }).format(ctx.now)
  if (args.newStartDate < today) return refuse('invalid_arguments', 'The new first day is in the past.')

  if (args.customerConfirmed) {
    const asked = await lastQuestion(ctx)
    const day = String(Number(args.newStartDate.slice(8, 10)))
    if (!/\?/.test(asked) || !new RegExp(`\\b${day}(?:st|nd|rd|th)?\\b`).test(asked)) {
      return refuse('invalid_arguments', 'You have not put these dates to them yet. Call again with customerConfirmed false, tell them the new price, and ask.')
    }
  }

  const result = await moveBookingDates(ctx.transact, {
    operatorId: ctx.operatorId, conversationId: ctx.conversationId, enquiryId: ctx.enquiryId,
    newStartDate: args.newStartDate, newEndDate: args.newEndDate, apply: args.customerConfirmed, now: ctx.now,
  })
  if (!result.ok) {
    return refuse('nothing_to_do', result.detail,
      result.reason === 'over_ceiling' || result.reason === 'extended'
        ? `Customer wants to move their booking to ${args.newStartDate}–${args.newEndDate}; a person has to approve it.`
        : undefined)
  }

  const money = (minor: number) => formatMoneyMinor(minor, result.currency)
  const difference = result.differenceMinor === 0 ? null
    : result.differenceMinor > 0 ? `${money(result.differenceMinor)} more` : `${money(-result.differenceMinor)} less`

  if (!result.applied) {
    return ok({
      applied: false,
      total: money(result.totalMinor),
      difference,
      guidance: `NOTHING HAS CHANGED YET. The car is available for the new dates: ${result.days} day`
        + `${result.days === 1 ? '' : 's'}, ${money(result.totalMinor)}`
        + (difference === null ? ', the same as before' : ` — ${difference} than before`)
        + '. Put that to them with the dates and day names, and ask "Shall I move it?".',
    })
  }

  // The enquiry follows the booking, so a later quote is for the dates they now have.
  await recordFields(ctx.transact, {
    operatorId: ctx.operatorId, enquiryId: ctx.enquiryId,
    observations: [
      { field: 'start_at', value: args.newStartDate, sourceMessageId: ctx.messageId },
      { field: 'end_at', value: args.newEndDate, sourceMessageId: ctx.messageId },
    ],
  }).catch(() => undefined)

  return ok(
    {
      applied: true,
      total: money(result.totalMinor),
      difference,
      guidance: `MOVED: the booking is now ${args.newStartDate} to ${args.newEndDate}, ${money(result.totalMinor)}. Say so. `
        + (result.differenceMinor > 0
          ? `They owe ${money(result.differenceMinor)} more, added to what is due. `
          : result.refundMinor > 0
            ? `They had already paid, and the new total is ${money(result.refundMinor)} less: the team will refund the difference. `
            : '')
        + 'The handover time and place stay as they were unless they say otherwise.',
    },
    result.refundMinor > 0
      ? `Booking moved to ${args.newStartDate}–${args.newEndDate}; refund ${money(result.refundMinor)} of the rental already paid.`
      : undefined,
  )
}
