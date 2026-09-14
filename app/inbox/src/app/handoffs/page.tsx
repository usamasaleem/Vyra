import Link from 'next/link'
import { listOpenHandoffs } from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'
import { AcceptButton } from './accept-button'

/**
 * Build plan step 29's other half — the queue a person actually looks at.
 *
 * The tasks existed before this page did: raised correctly, escalated on time,
 * and visible to nobody. That is the shape of failure this project keeps
 * producing — a decision made properly that reaches no one — and a queue with
 * no screen is the purest version of it.
 */
export const dynamic = 'force-dynamic'

const REASON_LABEL: Record<string, string> = {
  customer_asked: 'asked for a person',
  qualified_lead: 'qualified lead',
  discount_requested: 'wants a discount',
  cannot_verify: 'cannot be verified',
  payment_or_dispute: 'payment or dispute',
  safety_or_accident: 'safety or accident',
  non_text_message: 'sent something unreadable',
  agent_uncertain: 'agent was unsure',
  turn_failed: 'agent failed',
}

function due(minutes: number, escalated: boolean): { text: string; late: boolean } {
  if (escalated || minutes < 0) {
    return { text: `${Math.abs(minutes)} min overdue`, late: true }
  }
  return { text: `${minutes} min left`, late: false }
}

export default async function HandoffsPage({
  searchParams,
}: {
  searchParams: Promise<{ mine?: string }>
}) {
  const actor = await requireActor()
  const filters = await searchParams
  const handoffs = await listOpenHandoffs(queryRunner(), actor.operatorId, {
    unclaimedOnly: filters.mine !== 'all',
  })

  return (
    <main className="shell">
      <h1>Handoff queue</h1>
      <p className="muted">
        Conversations the agent could not finish. Accepting one assigns the conversation to you.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem' }}>
        <Link className="button secondary" href="/handoffs">Unclaimed</Link>
        <Link className="button secondary" href="/handoffs?mine=all">All open</Link>
        <Link className="button secondary" href="/">Conversations</Link>
      </div>

      {handoffs.length === 0 ? (
        <p className="card muted">Nothing waiting. Every handoff has been picked up.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem' }}>
          {handoffs.map((h) => {
            const clock = due(h.minutesRemaining, h.escalatedAt !== null)
            return (
              <li
                key={h.id}
                className="card"
                style={
                  clock.late
                    ? { borderLeft: '3px solid var(--danger, #b91c1c)' }
                    : h.priority === 'urgent'
                      ? { borderLeft: '3px solid var(--accent, #b45309)' }
                      : undefined
                }
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>{h.customerName ?? h.whatsappNumber}</strong>
                  <span
                    className="muted"
                    style={{ fontSize: '0.8rem', fontWeight: clock.late ? 600 : 400 }}
                  >
                    {clock.text}
                  </span>
                </div>

                <p style={{ margin: '0.35rem 0 0.5rem' }}>{h.summary}</p>

                {h.lastCustomerMessage !== null && (
                  /* So the queue can be triaged without opening every item. */
                  <p className="muted" style={{ margin: '0 0 0.6rem', fontSize: '0.88rem' }}>
                    Last said: “{h.lastCustomerMessage}”
                  </p>
                )}

                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
                  <span className="tag">{REASON_LABEL[h.reason] ?? h.reason.replace(/_/g, ' ')}</span>
                  {h.priority !== 'normal' && <span className="tag">{h.priority}</span>}
                  {h.escalatedAt !== null && <span className="tag">escalated</span>}
                  <span className="tag">waiting {h.waitingSinceMinutes} min</span>
                </div>

                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {h.ownerMembershipId === null ? (
                    <AcceptButton handoffId={h.id} />
                  ) : (
                    <span className="muted" style={{ fontSize: '0.85rem' }}>Accepted</span>
                  )}
                  <Link className="button secondary" href={`/conversations/${h.conversationId}`}>
                    Open conversation
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
