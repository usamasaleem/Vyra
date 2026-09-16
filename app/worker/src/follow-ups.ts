import {
  findDueFollowUps, markFollowUpNeedsAPerson, markFollowUpSent, queueOutboundText,
  raiseHandoff, scheduleFollowUp, type QueryRunner,
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

/**
 * How long to wait before the next chase, in minutes, indexed by the attempt
 * just sent.
 *
 * Shaped entirely by the 24-hour window. A free-form WhatsApp message is only
 * permitted within a day of the customer's last one, and this pilot has no
 * approved templates, so every chase has to fit inside that day or it is not a
 * chase at all — it is a task for a person.
 *
 * The first goes out four hours after the agent's reply. Six hours later, then
 * ten: twenty hours after the customer last wrote, with the window closing at
 * twenty-four. Three attempts is where it stops, because a fourth inside the
 * window would have to be so close to the third that it reads as pestering,
 * and outside it is not available at any spacing.
 *
 * Before this there was exactly one. Nothing incremented `attempt`, so a
 * customer who went quiet was chased once and then never contacted again by
 * anything — which, with follow-ups the only automatic outbound message in the
 * system, meant the lead simply stopped existing.
 */
const NEXT_CHASE_AFTER_MINUTES: Record<number, number> = {
  1: 6 * 60,
  2: 10 * 60,
}

export type FollowUpSweep = {
  sent: number
  raisedForAPerson: number
  /** Chases queued for later, because one sent is not the end of it. */
  rescheduled: number
}

export async function sendDueFollowUps(
  run: QueryRunner,
  log: (fields: Record<string, unknown>) => void,
): Promise<FollowUpSweep> {
  const due = await findDueFollowUps(run)
  let sent = 0
  let raisedForAPerson = 0
  let rescheduled = 0

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

    /**
     * The next one, or a person.
     *
     * Scheduled rather than sent: the customer may well answer this chase, and
     * `cancelFollowUps` on their reply is what stops the next. The eligibility
     * conditions live inside scheduleFollowUp's own predicate, so a takeover,
     * an opt-out or a closed lead between now and then all stop it there.
     */
    const gap = NEXT_CHASE_AFTER_MINUTES[item.attempt]
    if (gap !== undefined) {
      const next = await scheduleFollowUp(run, {
        operatorId: item.operatorId,
        conversationId: item.conversationId,
        reason: item.reason,
        afterMinutes: gap,
        attempt: item.attempt + 1,
      })
      if (next.scheduled) {
        rescheduled++
        log({ event: 'followup.rescheduled', conversation: item.conversationId, attempt: item.attempt + 1 })
      }
      continue
    }

    /**
     * Chased as many times as is decent and still nothing.
     *
     * A lead that stopped replying is not a lead that went away, and the last
     * automatic message is the point where it should become somebody's to
     * call. Silence after the final chase is how a lead disappears without
     * anybody deciding to let it.
     */
    await raiseHandoff(run, {
      operatorId: item.operatorId,
      conversationId: item.conversationId,
      reason: 'cannot_verify',
      summary:
        `Chased ${item.attempt} times with no reply, and the 24-hour window is closing. ` +
        `Worth a call if this lead is worth keeping.`,
    })
    raisedForAPerson++
    log({ event: 'followup.exhausted', conversation: item.conversationId, attempts: item.attempt })
  }

  return { sent, raisedForAPerson, rescheduled }
}
