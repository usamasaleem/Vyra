import {
  ASK_FOR, BEFORE_HANDOVER, activeBookingFor, bookingChecklist, recordBookingProgress, recordFields,
} from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { recordBookingProgressSchema } from './schemas.js'
import type { z } from 'zod'

export type BookingProgress = {
  /** What is still to collect, in the order worth asking. */
  stillNeeded: string[]
  guidance: string
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

  /**
   * Too soon to reach them. A same-day rental asked for in an hour is a car a
   * driver may not get to; the operator says how much notice they need, and a
   * time inside it is not saved — the agent offers the earliest that works.
   */
  const current = await bookingChecklist(ctx.run, { operatorId: ctx.operatorId, bookingId })
  const tooSoon = args.deliveryTime === null || current?.startDate == null
    ? null
    : await (async () => {
      const [operator] = await ctx.run(
        `select handover_notice_minutes from operators where id = $1`, [ctx.operatorId])
      const notice = operator?.['handover_notice_minutes']
      if (notice == null) return null
      const civil = (d: Date) => new Intl.DateTimeFormat('en-CA', {
        timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d)
      if (current.startDate !== civil(ctx.now)) return null
      // Rounded up to the next quarter hour, the way a person would offer it.
      const earliest = new Date(Math.ceil((ctx.now.getTime() + Number(notice) * 60_000) / 900_000) * 900_000)
      if (civil(earliest) !== civil(ctx.now)) return { earliest: null }
      const hhmm = new Intl.DateTimeFormat('en-GB', {
        timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(earliest)
      return args.deliveryTime! < hhmm ? { earliest: hhmm } : null
    })()
  const timeRefused = tooSoon === null
    ? null
    : tooSoon.earliest === null
      ? 'The time they asked for is too soon to get the car to them today, and there is not enough of '
        + 'today left. Say so kindly and ask whether first thing tomorrow works. The time was not saved. '
      : `The time they asked for is too soon — the earliest the car can be ready today is `
        + `${tooSoon.earliest}. Offer ${tooSoon.earliest} or later, in a sentence. The time was not saved. `

  /**
   * Delivery or collection lives on the enquiry, where the checklist reads it.
   *
   * Live: "I'll collect it" was answered in words and recorded nowhere — this
   * tool had no field for it and the enquiry questions had stopped once the car
   * was booked — so the checklist still did not know, and the collection time
   * was never asked for.
   */
  const before = await bookingChecklist(ctx.run, { operatorId: ctx.operatorId, bookingId })
  const switched = args.handover !== null && before !== null && before.handover !== null
    && before.handover !== args.handover
  if (args.handover !== null && before?.enquiryId != null && before.handover !== args.handover) {
    await recordFields(ctx.transact, {
      operatorId: ctx.operatorId,
      enquiryId: before.enquiryId,
      observations: [{ field: 'delivery_preference', value: args.handover, sourceMessageId: ctx.messageId }],
    })
  }

  await recordBookingProgress(ctx.run, {
    operatorId: ctx.operatorId,
    bookingId,
    deliveryAddress: args.deliveryAddress,
    deliveryTime: timeRefused === null ? args.deliveryTime : null,
    paymentPlan: args.paymentPlan,
    saysPaid: args.saysPaid === true,
    clearTime: switched,
    returnTime: args.returnTime,
    returnAddress: args.returnAddress,
  })

  const list = await bookingChecklist(ctx.run, { operatorId: ctx.operatorId, bookingId })
  const missing = list?.missing ?? []
  // The same rule the summary uses: a way to pay chosen is enough to send it.
  const open = (list: { missing: typeof missing; paymentPlan: string | null } | null) =>
    (list?.missing ?? []).filter((m) => BEFORE_HANDOVER.includes(m)
      && !(m === 'payment' && list?.paymentPlan != null))
  const wasOpen = open(before).length > 0
  const nowReady = open(list).length === 0
  const onlyTheMoney = missing.length === 1 && missing[0] === 'payment' && list?.paymentPlan != null

  if (timeRefused !== null) {
    return ok({ stillNeeded: missing.map((m) => ASK_FOR[m]), guidance: timeRefused })
  }

  return ok({
    stillNeeded: missing.map((m) => ASK_FOR[m]),
    guidance: wasOpen && nowReady
      ? 'That is everything the handover needs. A summary of the whole booking is sent to them '
        + 'automatically straight after your reply, so do not list the details — thank them in a '
        + 'sentence'
        + (onlyTheMoney ? ' and ask them to let you know here once they have paid.' : ' and stop.')
      : missing.length === 0 || onlyTheMoney
        ? 'Everything is in. Thank them in a few words and stop — do not ask for anything else.'
        : `Acknowledge what they gave in a few words, then ask for ${ASK_FOR[missing[0]!]}. One thing `
          + 'at a time.',
  })
}
