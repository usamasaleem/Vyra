import {
  bookingChecklist, dueReminders, getApprovedAnswer, queueOutboundText, recordOutstandingWork,
  reminderKey, renderHandoverFacts, renderReturnFacts, type QueryRunner,
} from '@vyra/db'

/**
 * Sending the day-before messages that have come due.
 *
 * The same two things stop one as stop a follow-up, and for the same reasons:
 * the operator has not written it, or WhatsApp's 24-hour window has closed and
 * only an approved template may go. Neither is dropped silently. Both become
 * work on the conversation — a customer who was going to be reminded about
 * tomorrow and was not is somebody a person should call today.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000

export type ReminderSweep = { sent: number; raisedForAPerson: number }

export async function sendDueReminders(
  run: QueryRunner,
  log: (fields: Record<string, unknown>) => void,
): Promise<ReminderSweep> {
  let sent = 0
  let raisedForAPerson = 0

  for (const due of await dueReminders(run)) {
    const list = await bookingChecklist(run, { operatorId: due.operatorId, bookingId: due.bookingId })
    if (list === null) continue

    const written = await getApprovedAnswer(run, due.operatorId, due.kind)
    const inside = due.lastCustomerMessageAt !== null
      && Date.now() - due.lastCustomerMessageAt.getTime() < WINDOW_MS
    const what = due.kind === 'handover-reminder'
      ? `remind them about the ${list.vehicle ?? 'car'} going out tomorrow`
      : `arrange the return of the ${list.vehicle ?? 'car'}, due back ${list.endDate ?? 'soon'}`

    const blocked = written === null
      ? `${what} — the ${due.kind === 'handover-reminder' ? 'day-before' : 'return'} message is not `
        + 'written under Messages, so it was not sent'
      : !inside
        ? `${what} — they last wrote more than 24 hours ago, so WhatsApp only allows an approved `
          + 'template; call or message them'
        : null

    if (blocked !== null) {
      // The sweep runs every minute; only the first time it changes anything
      // is worth counting. recordOutstandingWork is a no-op when unchanged.
      const raised = due.lastInboundMessageId === null ? { recorded: false } : await recordOutstandingWork(run, {
        conversationId: due.conversationId,
        operatorId: due.operatorId,
        items: [blocked],
        messageId: due.lastInboundMessageId,
      })
      if (raised.recorded) {
        raisedForAPerson += 1
        log({ event: 'reminder.needs_a_person', kind: due.kind, booking: due.bookingId, reason: blocked })
      }
      continue
    }

    const collectionPoint = list.handover === 'collection'
      ? (await getApprovedAnswer(run, due.operatorId, 'collection-point'))?.answer ?? null
      : null
    const facts = due.kind === 'handover-reminder'
      ? renderHandoverFacts(list, { collectionPoint })
      : renderReturnFacts(list)

    await queueOutboundText(run, {
      conversationId: due.conversationId,
      operatorId: due.operatorId,
      body: `${written!.answer}\n\n${facts}`,
      idempotencyKey: reminderKey(due),
    })
    sent += 1
    log({ event: 'reminder.sent', kind: due.kind, booking: due.bookingId })
  }

  return { sent, raisedForAPerson }
}
