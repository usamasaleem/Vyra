import {
  findDueFollowUps, markFollowUpNeedsAPerson, markFollowUpSent, queueOutboundText,
  raiseHandoff, type QueryRunner,
} from '@vyra/db'

/**
 * Sending the chases that have come due.
 *
 * Section 11: "Send only approved automated follow-ups." Two things can stop
 * one, and neither is fixed by trying again later, so neither is retried:
 *
 * The operator has published no follow-up policy. There is then no approved
 * wording, and the agent composing its own would be exactly the unapproved
 * automated follow-up the rule forbids. This is the common case today — the
 * `follow-up-timing` question is one of the six still unanswered.
 *
 * The 24-hour window has closed. WhatsApp does not permit a free-form message
 * outside it at all; that needs a Meta-approved template, which this pilot does
 * not have. Sending anyway is not an option, and dropping it silently is what
 * section 18.10 explicitly rules out.
 *
 * Both become a task. A customer who was going to be chased and was not is a
 * lead somebody should still call.
 */

export type FollowUpSweep = {
  sent: number
  raisedForAPerson: number
}

export async function sendDueFollowUps(
  run: QueryRunner,
  log: (fields: Record<string, unknown>) => void,
): Promise<FollowUpSweep> {
  const due = await findDueFollowUps(run)
  let sent = 0
  let raisedForAPerson = 0

  for (const item of due) {
    const blocked =
      item.approvedPolicy === null
        ? 'no approved follow-up policy is published'
        : !item.insideWindow
          ? 'outside the 24-hour window, which needs an approved template'
          : null

    if (blocked !== null) {
      await markFollowUpNeedsAPerson(run, {
        followUpId: item.id, operatorId: item.operatorId, reason: blocked,
      })
      await raiseHandoff(run, {
        operatorId: item.operatorId,
        conversationId: item.conversationId,
        reason: 'cannot_verify',
        summary: `Follow-up due and not sent — ${blocked}. Contact this customer yourself.`,
      })
      raisedForAPerson++
      log({ event: 'followup.needs_a_person', followUp: item.id, reason: blocked })
      continue
    }

    /**
     * The operator's own words, verbatim.
     *
     * Not a model rephrasing them, and not a template assembled here. The
     * published policy is what the operator approved being sent, and anything
     * else is a different message with their name on it.
     */
    const body = item.approvedPolicy as string

    const queued = await queueOutboundText(run, {
      conversationId: item.conversationId,
      operatorId: item.operatorId,
      body,
      // Per follow-up, so a retried sweep cannot chase the same customer twice.
      idempotencyKey: `followup:${item.id}`,
    })

    await markFollowUpSent(run, {
      followUpId: item.id, operatorId: item.operatorId, body, messageId: queued.messageId,
    })
    sent++
    log({ event: 'followup.sent', followUp: item.id, conversation: item.conversationId })
  }

  return { sent, raisedForAPerson }
}
