import Link from 'next/link'
import { listOpenOperationsRequests } from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'
import { AnswerForm } from './answer-form'

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
  const requests = await listOpenOperationsRequests(queryRunner(), actor.operatorId)

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
      </div>

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
