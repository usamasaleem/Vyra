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
  for (const extra of list.addOns) lines.push(`Extra: ${extra.label} — ${money(extra.amountMinor)}`)
  lines.push(`Payment: ${paymentLine(list)}`)
  lines.push(list.documentsCheckedAt !== null
    ? 'Documents: checked'
    : list.documents === 0 && list.documentsOnFileFrom !== null
      ? 'Documents: on file from your last rental — bring the originals on the day'
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
    list.deliveryAddress, ...list.addOns.map((a) => a.label),
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

/**
 * The one question the booking needs next, in words a customer reads — or null
 * when it needs nothing.
 *
 * One place for it: the photo reply and the documents-checked message both end
 * on it, and two copies drifted before (one asked "on the first day" while the
 * other said the day's name).
 */
export function nextQuestion(list: Checklist): string | null {
  const next = list.missing[0]
  if (next === undefined) return null
  const first = list.startDate === null
    ? 'the first day'
    : new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' })
      .format(new Date(`${list.startDate}T00:00:00Z`))
  const last = list.endDate === null
    ? 'the last day'
    : new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' })
      .format(new Date(`${list.endDate}T00:00:00Z`))
  switch (next) {
    case 'handover_choice': return 'Would you like it delivered, or will you collect it?'
    case 'delivery_address': return 'What address should the car go to — the building or villa and the area?'
    case 'delivery_time': return `What time on ${first} would you like it?`
    case 'collection_time': return `What time on ${first} will you come to collect it?`
    case 'documents': return 'Could you send a photo of your driving licence and your passport or Emirates ID here?'
    case 'payment': return 'How would you like to pay — bank transfer, a payment link, or card or cash at the handover?'
    case 'return_time': return `What time on ${last} should the car come back?`
    case 'return_address': return 'Where should we collect the car from at the end — the same address?'
  }
}
