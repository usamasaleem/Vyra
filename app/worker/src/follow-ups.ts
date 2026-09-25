import { BOOKING_NOW, BOOKING_NOW_OR_HOLD } from '@vyra/contracts'
import {
  cancelFollowUpsWaitingOnTheTeam, findDueFollowUps, followUpFacts, markFollowUpNeedsAPerson, markFollowUpSent, queueOutboundText,
  queueTemplateMessage, raiseHandoff, scheduleFollowUp, templateApproved, type QueryRunner,
} from '@vyra/db'
import { firstName } from './dispatcher.js'

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
 * When the second chase goes, and why there is no third.
 *
 * The first version laddered in multiples of the operator's own gap — six
 * times, then twelve. With a five-minute opening nudge that produced three
 * messages inside ninety-five minutes, and the middle two arrived thirty
 * minutes apart saying exactly the same sentence. Read back, it is not a
 * salesperson following up. It is a machine with a timer.
 *
 * The two gaps are not proportional to each other and treating them as such
 * was the mistake. The first is about catching somebody who is still holding
 * their phone, which is minutes. The second is about catching them later in
 * the day, which is hours, and it does not get shorter because the first one
 * was quick.
 *
 * So: four hours, or twice the operator's gap if they have set a long one.
 * Then a person. Three unanswered messages is where a lead stops being a lead
 * and starts being a complaint.
 */
const SECOND_CHASE_AFTER_MINUTES = (firstGapMinutes: number): number =>
  Math.max(4 * 60, firstGapMinutes * 2)

/** Two, then somebody calls. */
const LAST_ATTEMPT = 2

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
  const { cancelled } = await cancelFollowUpsWaitingOnTheTeam(run)
  if (cancelled > 0) log({ event: 'followups.cancelled', reason: 'waiting on the team', count: cancelled })
  const due = await findDueFollowUps(run)
  let sent = 0
  let raisedForAPerson = 0
  let rescheduled = 0

  for (const item of due) {
    /**
     * Past the 24 hours, the car they were quoted is offered once more in the
     * approved template — only while it is genuinely still available. Nothing
     * else is allowed out there, and a car that has gone is not worth a
     * message nobody asked for.
     */
    if (!item.insideWindow && await templateApproved(run, { operatorId: item.operatorId, key: 'quote_follow_up' })) {
      const facts = await followUpFacts(run, { operatorId: item.operatorId, conversationId: item.conversationId }).catch(() => null)
      if (facts !== null && (facts.state === 'available' || facts.state === 'held')) {
        const [who] = await run(
          `select c.display_name from conversations v join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
           where v.id = $1 and v.operator_id = $2`, [item.conversationId, item.operatorId])
        const queued = await queueTemplateMessage(run, {
          operatorId: item.operatorId,
          conversationId: item.conversationId,
          key: 'quote_follow_up',
          params: [firstName((who?.['display_name'] as string) ?? null), facts.vehicle, facts.dates],
          idempotencyKey: `followup:${item.id}`,
        })
        await markFollowUpSent(run, {
          followUpId: item.id, operatorId: item.operatorId, body: `template: quote_follow_up`, messageId: queued.messageId,
        })
        sent++
        log({ event: 'followup.sent', followUp: item.id, conversation: item.conversationId, as: 'template' })
        continue
      }
    }

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
    /**
     * With the car underneath, checked now: which one, when, what it costs,
     * and whether it is still available or held for them. The operator's line
     * stays first and unchanged — this is the record's part, not a rewording.
     */
    const facts = await followUpFacts(run, {
      operatorId: item.operatorId, conversationId: item.conversationId,
    }).catch(() => null)
    const body = facts === null
      ? item.approvedPolicy as string
      : `${item.approvedPolicy as string}\n\n${facts.text}`

    /**
     * One tap to say yes, when there is a yes to say: the car is available, or
     * already held for them. Not under a chase whose car has gone.
     */
    const [flags] = facts === null || (facts.state !== 'available' && facts.state !== 'held')
      ? []
      : await run(
        `select auto_confirm_bookings and availability_calendar_complete as may_confirm, hold_minutes
         from operators where id = $1`, [item.operatorId])
    const replyButtons = flags?.['may_confirm'] !== true
      ? null
      : facts!.state === 'available' && flags['hold_minutes'] != null
        ? BOOKING_NOW_OR_HOLD
        : BOOKING_NOW

    const queued = await queueOutboundText(run, {
      conversationId: item.conversationId,
      operatorId: item.operatorId,
      body,
      // Per follow-up, so a retried sweep cannot chase the same customer twice.
      idempotencyKey: `followup:${item.id}`,
      replyButtons,
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
    if (item.attempt < LAST_ATTEMPT) {
      const [operator] = await run(
        `select follow_up_after_minutes from operators where id = $1`, [item.operatorId],
      )
      const gap = SECOND_CHASE_AFTER_MINUTES(Number(operator?.['follow_up_after_minutes'] ?? 240))
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
