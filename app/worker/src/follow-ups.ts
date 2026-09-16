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
 * `follow-up-message` question is one of those still unanswered.
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
 * Each later chase as a multiple of the operator's own first gap.
 *
 * Fixed hours were wrong the moment the first gap changed. They were written
 * around a four-hour opening chase; the pilot set it to ten minutes, because a
 * customer who asks about a Huracán and goes quiet for ten minutes is still
 * holding their phone, and six hours later they are not. A ladder in multiples
 * moves with that instead of contradicting it.
 *
 * Nothing caps the total. It does not need one: the 24-hour window is checked
 * at the moment of sending, and a chase that has fallen outside it becomes a
 * task for a person rather than a message. That check was already there and is
 * the only thing that can be right about it, since the window is measured from
 * the customer's last message and not from anything scheduled here.
 *
 * Three attempts. Before this there was one — `attempt` existed and nothing
 * incremented it, so a customer who went quiet was chased once and then never
 * contacted by anything again.
 */
const LATER_CHASES_AT: Record<number, number> = {
  1: 6,
  2: 12,
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
    const multiple = LATER_CHASES_AT[item.attempt]
    if (multiple !== undefined) {
      const [operator] = await run(
        `select follow_up_after_minutes from operators where id = $1`, [item.operatorId],
      )
      const gap = Number(operator?.['follow_up_after_minutes'] ?? 240) * multiple
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
