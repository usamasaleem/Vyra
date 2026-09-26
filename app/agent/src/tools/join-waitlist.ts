import { joinWaitlist, searchFleet } from '@vyra/db'
import type { z } from 'zod'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { joinWaitlistSchema } from './schemas.js'

export type WaitlistJoined = { vehicle: string; guidance: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * "Tell me if it frees up", for a car that is booked on their dates.
 *
 * Only a car the operator's calendar says no to: that is the one thing a
 * message can later be triggered by. The promise it lets the agent make is
 * a small one on purpose — they will hear if it comes free, not that it will.
 */
export async function joinWaitlistTool(
  ctx: ToolContext,
  args: z.infer<typeof joinWaitlistSchema>,
): Promise<ToolResult<WaitlistJoined>> {
  if (!ISO_DATE.test(args.startDate) || !ISO_DATE.test(args.endDate)) {
    return refuse('invalid_arguments', 'Pass both dates resolved, as YYYY-MM-DD.')
  }
  if (args.endDate < args.startDate) {
    return refuse('invalid_arguments', `The last day ${args.endDate} is before the first day ${args.startDate}. Check the dates with them.`)
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone }).format(ctx.now)
  if (args.startDate < today) return refuse('invalid_arguments', 'The first day is in the past.')

  const found = await searchFleet(ctx.run, ctx.operatorId, args.vehicle)
  if (found.matches.length !== 1) {
    return refuse('invalid_arguments', found.matches.length === 0
      ? `No car in the fleet matches "${args.vehicle}". Use the exact make and model search_vehicles returned.`
      : `"${args.vehicle}" matches more than one car. Use the exact make and model of the one they want.`)
  }
  const car = found.matches[0]!
  const vehicle = [car.make, car.model, car.variant].filter(Boolean).join(' ')

  const result = await joinWaitlist(ctx.run, {
    operatorId: ctx.operatorId, conversationId: ctx.conversationId, vehicleId: car.id,
    startDate: args.startDate, endDate: args.endDate,
  })
  if (!result.ok) {
    return refuse('nothing_to_do', result.reason === 'theirs'
      ? 'They have already booked this car for those dates. Say so as a reminder.'
      : `The ${vehicle} is not booked for those dates, so there is nothing to wait for. Do not offer the waitlist for it.`)
  }

  return ok({
    vehicle,
    guidance: `ON THE LIST: they will get a message here the moment the ${vehicle} becomes available for those dates. `
      + 'Say so in one short sentence. Do not say it will come free, or how likely it is, and do not say they are first '
      + 'in line — whoever confirms first once it is free gets it. Keep offering alternatives if they want one meanwhile.',
  })
}
