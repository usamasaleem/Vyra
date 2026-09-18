import { formatDateForMessage } from '@vyra/contracts'
import {
  formatMoney, getNavCounts, listBookingRequests, listConfirmedBookings,
} from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { BookingForm } from './booking-form'
import { CancelForm } from './cancel-form'

/**
 * The people who said yes.
 *
 * Until bookings existed there was no such list, and there was nothing to put
 * in one: `request_booking_review` refused every call it received, so a
 * customer agreeing to a price became a handoff with no figures attached —
 * sitting in the same queue, in the same words, as somebody asking about
 * parking. Three quotes were sent during the pilot and `booking_status` read
 * 'none' on every conversation in the database.
 *
 * Oldest first. Everybody here has already committed, and a newest-first queue
 * starves its oldest item, which is how two handoffs from the fifteenth were
 * still open on the eighteenth.
 */
export const dynamic = 'force-dynamic'

function waitingFor(since: Date): string {
  const minutes = Math.floor((Date.now() - since.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default async function BookingsPage() {
  const actor = await requireActor()
  const [counts, waiting, onTheBooks] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listBookingRequests(run, actor.operatorId),
    listConfirmedBookings(run, actor.operatorId),
  ]))

  const canAnswer = permissions.canReply(actor)
  const tz = 'Asia/Dubai'

  return (
    <main className="shell">
      <SiteNav current="bookings" counts={counts} />
      <h1>Bookings to confirm</h1>
      <p className="muted">
        Customers who agreed to a price. The agent records the yes and can go no further — it
        cannot confirm a booking, and it has been told not to say anything is held. Until one of
        your people answers here, nobody has told them anything.
      </p>

      {waiting.length === 0 && (
        <p className="card">
          Nobody is waiting. When a customer accepts a quote they appear here with the figures
          they agreed to.
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: '1.5rem 0 0', display: 'grid', gap: '1rem' }}>
        {waiting.map((b) => {
          const who = b.customerName ?? b.customer
          const car = b.vehicle ?? 'the car'
          const dates = b.startDate === null
            ? null
            : b.endDate === null || b.endDate.getTime() === b.startDate.getTime()
              ? formatDateForMessage(b.startDate, tz)
              : `${formatDateForMessage(b.startDate, tz)} to ${formatDateForMessage(b.endDate, tz)}`

          const total = formatMoney(b.totalMinor, b.currency)

          /**
           * Drafted, not decided. The figures and the car come from the quote
           * they agreed to rather than from anything retyped here, so the
           * message cannot disagree with what they were sent.
           */
          const confirmDraft = `Good news — the ${car} is confirmed`
            + `${dates === null ? '' : ` for ${dates}`}, ${total} in total.`
            + `${b.depositMinor === null ? '' : ` The refundable deposit is ${formatMoney(b.depositMinor, b.currency)}.`}`
            + ` I will be in touch shortly with what we need from you.`

          const declineDraft = `I am sorry — the ${car} is not available`
            + `${dates === null ? '' : ` for ${dates}`} after all.`
            + ` I can look at what else we have for those dates if that helps.`

          return (
            <li key={b.bookingId} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <strong>{who}</strong>
                  <span className="muted" style={{ fontSize: '0.8rem' }}> · said yes {waitingFor(b.requestedAt)}</span>
                  <div style={{ margin: '0.35rem 0 0' }}>
                    {car}{dates === null ? '' : ` · ${dates}`}
                    {b.days === null ? '' : ` · ${b.days} ${b.days === 1 ? 'day' : 'days'}`}
                  </div>
                  <div className="muted" style={{ fontSize: '0.88rem' }}>
                    {total}
                    {b.depositMinor === null
                      ? ''
                      : ` · ${formatMoney(b.depositMinor, b.currency)} deposit`}
                    {b.validUntil !== null && b.validUntil < new Date()
                      && ' · this price has expired since they agreed to it'}
                  </div>
                  {b.heldAlready !== null && (
                    <p className="notice" style={{ margin: '0.6rem 0 0' }}>
                      This car is already held from {b.heldAlready.startDate} to{' '}
                      {b.heldAlready.endDate} ({b.heldAlready.reason}), which overlaps these
                      dates. Confirming is refused until that is released — check the diary
                      below before you answer them.
                    </p>
                  )}
                </div>
                <a className="button secondary" href={`/conversations/${b.conversationId}`}>
                  Read the conversation
                </a>
              </div>

              {canAnswer ? (
                <BookingForm
                  bookingId={b.bookingId}
                  confirmDraft={confirmDraft}
                  declineDraft={declineDraft}
                />
              ) : (
                <p className="muted" style={{ margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
                  Your role cannot answer bookings.
                </p>
              )}
            </li>
          )
        })}
      </ul>

      <section style={{ marginTop: '2.5rem' }}>
        <h2 style={{ fontSize: '1.05rem' }}>On the books</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Confirmed rentals, soonest first. Each one holds its car for those dates, so the agent
          will not offer it to somebody else and a second confirmation is refused. Cancelling
          gives the car back.
        </p>

        {onTheBooks.length === 0 ? (
          <p className="card" style={{ marginTop: '0.8rem' }}>Nothing confirmed yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.6rem' }}>
            {onTheBooks.map((b) => (
              <li key={b.bookingId} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <strong>{b.vehicle ?? 'Car not recorded'}</strong>
                    <div className="muted" style={{ fontSize: '0.88rem' }}>
                      {b.startDate}
                      {b.endDate !== null && b.endDate !== b.startDate ? ` to ${b.endDate}` : ''}
                      {' · '}{b.customerName ?? b.customer}
                      {' · '}{formatMoney(b.totalMinor, b.currency)}
                      {b.confirmedBy === null ? '' : ` · confirmed by ${b.confirmedBy}`}
                    </div>
                  </div>
                  <a className="button secondary" href={`/conversations/${b.conversationId}`}>
                    Read the conversation
                  </a>
                </div>
                {canAnswer && <div style={{ marginTop: '0.7rem' }}><CancelForm bookingId={b.bookingId} /></div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
