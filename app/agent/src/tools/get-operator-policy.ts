import { getApprovedAnswer } from '@vyra/db'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { getOperatorPolicySchema } from './schemas.js'
import type { z } from 'zod'

export type OperatorPolicy = {
  topic: string
  answer: string
  /** The exact version this wording came from, so a later dispute is answerable. */
  version: number
  confirmedBy: string
  effectiveFrom: string
}

/**
 * Mandatory check (section 18.8): operator scope and source version.
 *
 * Scope is structural — the operator id comes from `ctx`, so there is no
 * argument through which another operator's policy could be named.
 *
 * Source version is the part that needs saying out loud. The answer is
 * returned with the version and the person who confirmed it, and the query
 * filters on `published_at is not null` plus the effective window, so an
 * unpublished draft and a retired answer are both invisible here. When a
 * customer quotes an answer back three days later, the version in the agent
 * run is what makes "yes, that is what we told you" checkable.
 *
 * Refusing when nothing is published is the whole point, not a limitation.
 * Section 5 requires the agent to show uncertainty when approved information is
 * missing; a plausible-sounding default deposit figure is precisely the failure
 * this system exists to prevent.
 */
export async function getOperatorPolicy(
  ctx: ToolContext,
  args: z.infer<typeof getOperatorPolicySchema>,
): Promise<ToolResult<OperatorPolicy>> {
  const answer = await getApprovedAnswer(ctx.run, ctx.operatorId, args.topic, ctx.now)
  if (answer === null) {
    return refuse(
      'no_approved_answer',
      `This operator has not published an approved answer for "${args.topic}". Tell the customer `
        + 'the team will confirm it, and do not estimate. It is already flagged for a person — do '
        + 'NOT hand the conversation over for it: keep helping with everything else, and if they '
        + 'have a car and dates, price it and offer to book or hold it as usual.'
        + (args.topic === 'deposit'
          ? ' The deposit for a specific car is not this policy: prepare_quote returns it with the '
            + 'price, and you may state that figure.'
          : ''),
      `publish an approved answer for "${args.topic}"`,
    )
  }
  return ok({
    topic: answer.topic,
    answer: answer.answer,
    version: answer.version,
    confirmedBy: answer.confirmedBy,
    effectiveFrom: answer.effectiveFrom.toISOString(),
  })
}
