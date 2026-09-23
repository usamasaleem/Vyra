import { holdCar } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { holdCarSchema } from './schemas.js'
import type { z } from 'zod'

export type CarHeld = {
  vehicle: string | null
  /** Their clock, as they would say it: "18:40 today", "10:15 tomorrow". */
  until: string
  guidance: string
}

/**
 * "Let me think about it", answered with a reason to come back.
 *
 * The time is worked out here, in the operator's clock, and handed over as a
 * sentence fragment — a model told "expires_at 2026-09-24T14:40:00Z" says a
 * time in the wrong zone about one time in three.
 */
export async function holdCarTool(
  ctx: ToolContext,
  args: z.infer<typeof holdCarSchema>,
): Promise<ToolResult<CarHeld>> {
  const result = await holdCar(ctx.transact, {
    operatorId: ctx.operatorId,
    conversationId: ctx.conversationId,
    quoteId: args.quoteId,
    now: ctx.now,
  })
  if (!result.ok) {
    return refuse(result.reason === 'no_quote' ? 'invalid_arguments' : 'nothing_to_do', result.detail)
  }

  const civil = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(result.until)
  const until = civil(result.until) === civil(ctx.now) ? `${time} today` : `${time} tomorrow`

  return ok({
    vehicle: result.vehicle,
    until,
    guidance: `HELD: the ${result.vehicle ?? 'car'} is theirs for those dates until ${until}, and nobody `
      + 'else can book it before then. Tell them so in one short sentence, with that time, and that '
      + 'they only need to say yes to book it. Do not ask them anything else in the same message.',
  })
}
