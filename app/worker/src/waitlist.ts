import { BOOKING_NOW, BOOKING_NOW_OR_HOLD, formatDateForMessage } from '@vyra/contracts'
import {
  closeWaitlistEntry, dueWaitlistNotices, queueOutboundText, queueTemplateMessage, recordOutstandingWork,
  templateApproved, waitlistNoticeKey, type QueryRunner, type WaitlistNotice,
} from '@vyra/db'
import { firstName } from './dispatcher.js'

/**
 * Telling the customers who were waiting that their car has come free.
 *
 * Everybody waiting for it hears at once, oldest first, and the car goes to
 * whoever books it: booking takes the car in the calendar, so the second yes
 * is refused there — by the same check that refuses any booking of a taken
 * car — and the agent offers them something else.
 *
 * Inside WhatsApp's 24 hours the message is ours, with a button to say yes
 * where the operator lets the agent book. Outside it only the approved
 * template may go; without one, or with a person running the conversation,
 * it becomes that person's to pass on rather than a message nobody sends.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000

export type WaitlistSweep = { sent: number; raisedForAPerson: number }

const day = (civil: string) => formatDateForMessage(new Date(`${civil}T12:00:00Z`), 'UTC')
const datesOf = (n: WaitlistNotice) => n.startDate === n.endDate ? day(n.startDate) : `${day(n.startDate)} to ${day(n.endDate)}`

export async function sendWaitlistNotices(
  run: QueryRunner,
  log: (fields: Record<string, unknown>) => void,
  options: { now?: Date } = {},
): Promise<WaitlistSweep> {
  const now = options.now ?? new Date()
  let sent = 0
  let raisedForAPerson = 0

  for (const notice of await dueWaitlistNotices(run, { now })) {
    const dates = datesOf(notice)
    const inside = notice.lastCustomerMessageAt !== null
      && now.getTime() - notice.lastCustomerMessageAt.getTime() < WINDOW_MS

    if (!notice.handledByAPerson && inside) {
      const queued = await queueOutboundText(run, {
        conversationId: notice.conversationId,
        operatorId: notice.operatorId,
        body: `Good news — the *${notice.vehicle}* is available for ${dates} after all. Shall I book it for you?`,
        idempotencyKey: waitlistNoticeKey(notice.entryId),
        replyButtons: !notice.mayConfirm ? null : notice.holdMinutes !== null ? BOOKING_NOW_OR_HOLD : BOOKING_NOW,
      })
      await closeWaitlistEntry(run, { operatorId: notice.operatorId, entryId: notice.entryId, reason: 'notified', messageId: queued.messageId })
      sent += 1
      log({ event: 'waitlist.notified', entry: notice.entryId, conversation: notice.conversationId })
      continue
    }

    if (!notice.handledByAPerson && await templateApproved(run, { operatorId: notice.operatorId, key: 'waitlist_available' })) {
      const queued = await queueTemplateMessage(run, {
        operatorId: notice.operatorId,
        conversationId: notice.conversationId,
        key: 'waitlist_available',
        params: [firstName(notice.displayName), notice.vehicle, dates],
        idempotencyKey: waitlistNoticeKey(notice.entryId),
      })
      await closeWaitlistEntry(run, { operatorId: notice.operatorId, entryId: notice.entryId, reason: 'notified', messageId: queued.messageId })
      sent += 1
      log({ event: 'waitlist.notified', entry: notice.entryId, conversation: notice.conversationId, as: 'template' })
      continue
    }

    const item = `tell them the ${notice.vehicle} they were waiting for is now available for ${dates} — `
      + (notice.handledByAPerson
        ? 'a person is handling this conversation, so it was not sent automatically'
        : 'they last wrote more than 24 hours ago, so WhatsApp only allows an approved template; call or message them')
    if (notice.handledByAPerson) {
      // Their next action is theirs to set; a note is what reaches them.
      await run(
        `insert into conversation_notes (operator_id, conversation_id, author_membership_id, body)
         values ($1, $2, null, $3)`,
        [notice.operatorId, notice.conversationId, `Waitlist: ${item}.`],
      )
    } else if (notice.lastInboundMessageId !== null) {
      await recordOutstandingWork(run, {
        conversationId: notice.conversationId,
        operatorId: notice.operatorId,
        items: [item],
        messageId: notice.lastInboundMessageId,
      })
    }
    await closeWaitlistEntry(run, { operatorId: notice.operatorId, entryId: notice.entryId, reason: 'needs_a_person' })
    raisedForAPerson += 1
    log({ event: 'waitlist.needs_a_person', entry: notice.entryId, conversation: notice.conversationId })
  }

  return { sent, raisedForAPerson }
}
