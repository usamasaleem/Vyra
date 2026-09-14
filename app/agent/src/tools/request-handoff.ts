import { requestHandoff as requestHandoffQuery } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { requestHandoffSchema } from './schemas.js'
import type { z } from 'zod'

export type HandoffRequested = {
  /** True for the call that paused sending; false for a harmless repeat. */
  paused: boolean
  alreadyWithAPerson: boolean
  /** AI drafts that were queued and have now been cancelled. */
  cancelledDrafts: number
  revision: number | null
}

/**
 * Mandatory check (section 18.8): an idempotent task, and sending paused.
 *
 * Both are in the SQL rather than here. The idempotency predicate and the
 * cancellation of pending drafts are one statement in `requestHandoff`, so
 * asking twice cannot produce two revisions or two audit events, and sending
 * stops in the same transaction that records the request. A check that lives in
 * the caller is a check the caller can skip.
 *
 * Pausing matters more than it first appears. Section 18.11 draws the boundary
 * precisely: a message already handed to Meta cannot be recalled. What this can
 * do is cancel drafts that have not yet reached the dispatcher, and the
 * dispatcher re-checks ownership immediately before sending, so a draft in
 * flight between the two is caught there. The failure being prevented is a
 * customer who asked for a human receiving one more automated reply.
 *
 * This is also the tool the intent rules reach for. `detectStopSignal` finds
 * complaints, legal threats, accident reports and explicit requests for a
 * person before any model runs, and the correct response to all of them is
 * this call. It is deliberately the easiest tool to use successfully — no ids,
 * one sentence of reason — because the cost of an unnecessary handoff is a
 * salesperson reading a message, and the cost of a missed one is a customer
 * arguing with a machine.
 */
export async function requestHandoff(
  ctx: ToolContext,
  args: z.infer<typeof requestHandoffSchema>,
): Promise<ToolResult<HandoffRequested>> {
  const result = await requestHandoffQuery(ctx.run, {
    conversationId: ctx.conversationId,
    operatorId: ctx.operatorId,
    reason: args.reason,
  })

  if (!result.found) {
    return refuse('wrong_scope', 'That conversation does not belong to this operator.')
  }

  return ok({
    paused: result.paused,
    alreadyWithAPerson: result.alreadyHuman,
    cancelledDrafts: result.cancelledDrafts,
    revision: result.revision,
  })
}
