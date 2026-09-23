import { formatDateForMessage } from '@vyra/contracts'
import type { Checklist } from './booking-checklist.js'
import { formatMoney } from './quotes.js'

/**
 * What the customer is sent about their booking, rendered from the record.
 *
 * The same rule as the quote message: figures, dates and places come from the
 * rows, never from a model phrasing them. A summary that says 16:00 because the
 * booking says 16:00 cannot drift from what the driver is told.
 */

/** "2026-09-24" as "Thursday 24 September". The stored value is a civil date. */
const day = (civil: string): string =>
  formatDateForMessage(new Date(`${civil}T12:00:00Z`), 'UTC')

function paymentLine(list: Checklist): string {
  const money = (minor: number) => formatMoney(minor, list.currency)
  if (list.owedMinor === 0) {
    return list.paidMinor > 0 ? 'Paid — thank you' : 'Nothing to pay'
  }
  const owed = money(list.owedMinor)
  if (list.paymentPlan === 'on_delivery') return `${owed}, by card or cash at the handover`
  if (list.customerReportedPaidAt !== null) {
    return `${owed} — you have told us it is sent, and the team is confirming it arrived`
  }
  if (list.paymentLink !== null) return `${owed} — pay here: ${list.paymentLink}`
  return `${owed} still to pay`
}

function handoverLine(list: Checklist, collectionPoint: string | null): string | null {
  if (list.startDate === null) return null
  const when = `${day(list.startDate)}${list.deliveryTime === null ? '' : ` at ${list.deliveryTime}`}`
  if (list.handover === 'delivery') {
    return `Delivery: ${when}${list.deliveryAddress === null ? '' : `, to ${list.deliveryAddress}`}`
  }
  if (list.handover === 'collection') {
    return `Collection: ${when}${collectionPoint === null ? '' : ` — ${collectionPoint}`}`
  }
  return null
}

/**
 * The whole booking, once it is complete.
 *
 * Sent once when the last thing the handover needs arrives, and again only if
 * one of the details it states changes — a new time, a new address. Not when a
 * payment is marked taken: that is a change to the record, not to the plan,
 * and a second summary for it would be noise.
 */
export function renderBookingSummary(
  list: Checklist,
  options: { collectionPoint: string | null },
): string {
  const money = (minor: number) => formatMoney(minor, list.currency)
  const lines: string[] = ['Here is everything for your booking:', '']
  lines.push(`*${list.vehicle ?? 'Your car'}*`)
  if (list.startDate !== null) {
    const span = list.endDate !== null && list.endDate !== list.startDate
      ? `${day(list.startDate)} to ${day(list.endDate)}`
      : day(list.startDate)
    lines.push(list.days === null ? span : `${span} (${list.days} day${list.days === 1 ? '' : 's'})`)
  }
  const handover = handoverLine(list, options.collectionPoint)
  if (handover !== null) lines.push(handover)
  lines.push(`Rental: ${money(list.totalMinor)}`
    + (list.depositMinor === null ? '' : ` · refundable deposit: ${money(list.depositMinor)}`))
  lines.push(`Payment: ${paymentLine(list)}`)
  lines.push(list.documentsCheckedAt !== null
    ? 'Documents: checked'
    : `Documents: received — the team checks them before the handover`)
  if (list.endDate !== null && list.endDate !== list.startDate) {
    lines.push(`Returning: ${day(list.endDate)}`)
  }
  lines.push('', 'Reply here if anything needs to change.')
  return lines.join('\n')
}

/**
 * What the summary is about, for deciding whether it has been sent already.
 *
 * The plan, not the state: car, dates, how and when and where. A payment
 * being marked taken changes the summary's words and not its subject.
 */
export function summaryKey(list: Checklist): string {
  return [
    list.bookingId, list.startDate, list.endDate, list.handover, list.deliveryTime,
    list.deliveryAddress,
  ].join('|')
}

/**
 * The facts under the operator's day-before message: which car, when, where,
 * and anything still outstanding — the one message that can still catch a
 * missing payment before a driver is standing at the door.
 */
export function renderHandoverFacts(
  list: Checklist,
  options: { collectionPoint: string | null },
): string {
  const lines: string[] = [`*${list.vehicle ?? 'Your car'}*`]
  const handover = handoverLine(list, options.collectionPoint)
  if (handover !== null) lines.push(handover)
  if (list.owedMinor > 0) lines.push(`Payment: ${paymentLine(list)}`)
  if (list.missing.includes('documents')) {
    lines.push('Documents: still needed — a photo of your driving licence and your ID, here')
  }
  return lines.join('\n')
}

/** Which car is due back, and when. The operator's own message carries the ask. */
export function renderReturnFacts(list: Checklist): string {
  return `*${list.vehicle ?? 'Your car'}* — due back ${list.endDate === null ? 'soon' : day(list.endDate)}`
}
