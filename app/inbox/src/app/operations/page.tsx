import Link from 'next/link'
import { formatMoney, listDraftQuotes, listOpenOperationsRequests } from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'
import { AnswerForm } from './answer-form'
import { ApproveQuote } from './approve-quote'

/**
 * Build plan step 30 — the Operations console.
 *
 * Section 6: "For the MVP an authorised person answers these requests in the
 * Operations console. There is no automated availability lookup, and none
 * should be assumed."
 *
 * Every conversation that reached "I'm confirming availability with the team"
 * put a row here. Until this page existed, the team was not told.
 */
export const dynamic = 'force-dynamic'

export default async function OperationsPage() {
  const actor = await requireActor()
  const run = queryRunner()
  const [requests, drafts] = await Promise.all([
    listOpenOperationsRequests(run, actor.operatorId),
    listDraftQuotes(run, actor.operatorId),
  ])

  return (
    <main className="wrap">
      <h1>Operations requests</h1>
      <p className="muted">
        Questions the agent could not answer. A customer is waiting on each of these, and the
        agent will not state availability until somebody here does.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem' }}>
        <Link className="button secondary" href="/">Conversations</Link>
        <Link className="button secondary" href="/handoffs">Handoffs</Link>
        <Link className="button secondary" href="/rates">Rates</Link>
      </div>

      {/*
        Quotes first. A customer waiting on a price has been told one is coming,
        and the agent has been told nothing about the figures — so until
        somebody here looks, that promise is the only thing they have.
      */}
      {drafts.length > 0 && (
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Quotes waiting for approval</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.8rem' }}>
            {drafts.map((q) => (
              <li key={q.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>{q.customerName ?? q.whatsappNumber}</strong>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    revision {q.revision} · {q.days} day{q.days === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="muted" style={{ margin: '0.3rem 0 0.7rem', fontSize: '0.9rem' }}>
                  {q.vehicleLabel ?? 'Vehicle not recorded'}
                </p>

                <table style={{ width: '100%', maxWidth: '26rem', marginBottom: '0.8rem' }}>
                  <tbody>
                    {q.lines.map((l, i) => (
                      <tr key={i}>
                        <td style={{ padding: '0.15rem 0' }}>{l.label}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(l.amountMinor, q.currency)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 600 }}>
                      <td style={{ padding: '0.3rem 0', borderTop: '1px solid var(--line, #ddd)' }}>Total</td>
                      <td style={{ textAlign: 'right', borderTop: '1px solid var(--line, #ddd)' }}>
                        {formatMoney(q.totalMinor, q.currency)}
                      </td>
                    </tr>
                    {q.depositMinor !== null && (
                      <tr className="muted">
                        <td style={{ padding: '0.15rem 0' }}>Refundable deposit</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(q.depositMinor, q.currency)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <ApproveQuote quoteId={q.id} revision={q.revision} />
                <p style={{ margin: '0.7rem 0 0' }}>
                  <Link href={`/conversations/${q.conversationId}`}>Open the conversation</Link>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests.length === 0 ? (
        <p className="card muted">Nothing to check. The agent has everything it has asked for.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.8rem' }}>
          {requests.map((r) => (
            <li key={r.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <strong>{r.vehicleLabel ?? r.requestedVehicle ?? 'Unspecified vehicle'}</strong>
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  waiting {r.waitingMinutes} min
                </span>
              </div>

              <p style={{ margin: '0.35rem 0 0.6rem' }}>
                {r.startDate === null
                  ? 'No dates given'
                  : r.endDate === null || r.endDate === r.startDate
                    ? `On ${r.startDate}`
                    : `${r.startDate} to ${r.endDate}`}
              </p>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
                <span className="tag">{r.kind}</span>
                {/*
                  What the customer actually asked for, kept even when a vehicle
                  matched: "the yellow one" is how the person checking knows
                  they are looking at the right car.
                */}
                {r.requestedVehicle !== null && r.vehicleLabel !== null && (
                  <span className="tag">asked for “{r.requestedVehicle}”</span>
                )}
                {r.customerName !== null && <span className="tag">{r.customerName}</span>}
              </div>

              <AnswerForm requestId={r.id} />

              {r.conversationId !== null && (
                <p style={{ margin: '0.7rem 0 0' }}>
                  <Link href={`/conversations/${r.conversationId}`}>Open the conversation</Link>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
