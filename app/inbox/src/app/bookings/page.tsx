import { formatDateForMessage } from '@vyra/contracts'
import {
  bookingChecklist, formatMoney, getNavCounts, listBookingRequests, listConfirmedBookings,
  whatIsOwed,
} from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { BookingForm } from './booking-form'
import { CancelForm } from './cancel-form'
import { PaymentForm } from './payment-form'
import { checkDocuments } from './actions'

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
  const [counts, waiting, onTheBooks, operator] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listBookingRequests(run, actor.operatorId),
    listConfirmedBookings(run, actor.operatorId)
      .then(async (all) => Promise.all(all.map(async (b) => ({
        ...b,
        // What each one owes, so the diary answers "has this been paid" —
        // which is the question somebody actually has when a car is going out.
        owed: await whatIsOwed(run, { operatorId: actor.operatorId, bookingId: b.bookingId }),
        // What the agent has collected since confirming, so this reads as a
        // list of things to check rather than things to chase.
        checklist: await bookingChecklist(run, { operatorId: actor.operatorId, bookingId: b.bookingId }),
      })))),
    run(`select auto_confirm_bookings, auto_confirm_limit_minor, timezone from operators
         where id = $1`,
      [actor.operatorId]),
  ]))

  /**
   * What this page is depends on a setting, and saying the wrong one is worse
   * than saying nothing. With the agent confirming, most rentals never appear
   * in the top list at all — so a heading promising that nobody has been told
   * anything is a lie about the common case.
   */
  const agentConfirms = operator[0]?.['auto_confirm_bookings'] === true
  /**
   * Theirs, not the pilot's. Written as a constant when there was one operator
   * and every date on this page would have read in Dubai time for everybody
   * who came after them.
   */
  const tz = (operator[0]?.['timezone'] as string | undefined) ?? 'UTC'
  const ceilingMinor = operator[0]?.['auto_confirm_limit_minor'] == null
    ? null
    : Number(operator[0]!['auto_confirm_limit_minor'])
  /**
   * The currency the operator actually quotes in. Written as 'AED' when there
   * was one operator, which would have shown every later one their own
   * ceiling in somebody else's money.
   */
  const ceilingCurrency = waiting[0]?.currency ?? onTheBooks[0]?.currency ?? 'AED'

  const canAnswer = permissions.canReply(actor)

  return (
    <main className="shell">
      <SiteNav current="bookings" counts={counts} />
      <h1>Bookings</h1>
      <p className="muted">
        {agentConfirms
          ? 'The agent confirms a booking itself when it can prove the car is free, and those '
            + 'go straight onto the books below. Anything it cannot prove — a car already held, '
            + 'a conversation one of your people has taken over, an open handoff'
          : 'Customers who agreed to a price. The agent records the yes and can go no further — '
            + 'it cannot confirm a booking, and it has been told not to say anything is held'}
        {agentConfirms && ceilingMinor !== null
          ? `, or a total above ${formatMoney(ceilingMinor, ceilingCurrency)}`
          : ''}
        {agentConfirms
          ? ' — waits for one of your people here.'
          : '. Until one of your people answers here, nobody has told them anything.'}
      </p>

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Waiting for one of your people</h2>

      {waiting.length === 0 && (
        <p className="card">
          {agentConfirms
            ? 'Nobody is waiting. Anything the agent could not confirm on its own appears here '
              + 'with the figures the customer agreed to.'
            : 'Nobody is waiting. When a customer accepts a quote they appear here with the '
              + 'figures they agreed to.'}
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
                      {b.confirmedAutomatically
                        ? ' · confirmed by the agent'
                        : b.confirmedBy === null ? '' : ` · confirmed by ${b.confirmedBy}`}
                    </div>
                  </div>
                  <a className="button secondary" href={`/conversations/${b.conversationId}`}>
                    Read the conversation
                  </a>
                </div>
                {b.checklist !== null && (
                  <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 0.9rem', margin: '0.7rem 0 0', fontSize: '0.9rem' }}>
                    {b.checklist.deliveryWanted && (
                      <>
                        <dt className="muted">Delivery</dt>
                        <dd style={{ margin: 0 }}>
                          {b.checklist.deliveryAddress ?? <span className="muted">address not given yet</span>}
                          {' · '}
                          {b.checklist.deliveryTime ?? <span className="muted">time not given yet</span>}
                        </dd>
                      </>
                    )}
                    {!b.checklist.deliveryWanted && (
                      <>
                        <dt className="muted">Collection</dt>
                        <dd style={{ margin: 0 }}>
                          {b.checklist.deliveryTime ?? <span className="muted">time not given yet</span>}
                        </dd>
                      </>
                    )}
                    <dt className="muted">Payment</dt>
                    <dd style={{ margin: 0 }}>
                      {b.checklist.paymentPlan === null
                        ? <span className="muted">not chosen yet</span>
                        : { transfer: 'Bank transfer', link: 'Payment link', on_delivery: 'Card or cash on delivery' }[b.checklist.paymentPlan]}
                      {b.checklist.customerReportedPaidAt !== null && (
                        <strong> · customer says paid — check the account</strong>
                      )}
                    </dd>
                    <dt className="muted">Documents</dt>
                    <dd style={{ margin: 0, display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      {b.checklist.documentsCheckedAt !== null
                        ? <span>checked</span>
                        : (
                          <>
                            <span>
                              {b.checklist.documents === 0
                                ? <span className="muted">none received yet</span>
                                : `${b.checklist.documents} received · open the conversation to see them`}
                            </span>
                            {b.checklist.documents > 0 && canAnswer && (
                              <form action={checkDocuments}>
                                <input type="hidden" name="bookingId" value={b.bookingId} />
                                <button className="button secondary" type="submit">Mark checked</button>
                              </form>
                            )}
                          </>
                        )}
                    </dd>
                  </dl>
                )}
                {b.owed.length > 0 && (
                  <div className="stack" style={{ gap: '0.5rem', marginTop: '0.7rem' }}>
                    {b.owed.map((o) => (
                      canAnswer ? (
                        <PaymentForm
                          key={o.paymentId}
                          paymentId={o.paymentId}
                          kind={o.kind}
                          amount={formatMoney(o.amountMinor, o.currency)}
                          state={o.state}
                          linkUrl={o.linkUrl}
                        />
                      ) : (
                        <span key={o.paymentId} className="muted" style={{ fontSize: '0.88rem' }}>
                          {o.kind === 'deposit' ? 'Deposit' : 'Rental'}{' '}
                          {formatMoney(o.amountMinor, o.currency)} · {o.state}
                        </span>
                      )
                    ))}
                  </div>
                )}
                {canAnswer && <div style={{ marginTop: '0.7rem' }}><CancelForm bookingId={b.bookingId} /></div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
