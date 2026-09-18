import Link from 'next/link'
import { SiteNav } from '../site-nav'
import {
  formatDuration, getNavCounts, listFollowUpsNeedingAttention, listMembers, listOpenHandoffs,
} from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { AcceptButton } from './accept-button'
import { dismissFollowUp, finishHandoff } from './actions'

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

/**
 * Through the shared formatter rather than as raw minutes.
 *
 * This read "2225 min overdue", which is a day and a half and does not look
 * like one. A queue is read at a glance by somebody deciding what to pick up,
 * and a number they have to divide is a number they skip.
 */
function due(minutes: number, escalated: boolean): { text: string; late: boolean } {
  if (escalated || minutes < 0) {
    return { text: `${formatDuration(Math.abs(minutes) * 60)} overdue`, late: true }
  }
  return { text: `${formatDuration(minutes * 60)} left`, late: false }
}

export default async function HandoffsPage({
  searchParams,
}: {
  searchParams: Promise<{ mine?: string }>
}) {
  const actor = await requireActor()
  const filters = await searchParams
  const [counts, handoffs, members, chases] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listOpenHandoffs(run, actor.operatorId, { unclaimedOnly: filters.mine !== 'all' }),
    listMembers(run, actor.operatorId),
    listFollowUpsNeedingAttention(run, actor.operatorId),
  ]))

  /**
   * Who an escalation named, as a person rather than a uuid.
   *
   * The email rather than a display name because that is what the team page
   * shows and what an invitation was sent to; there is no other name on file.
   */
  const nameOf = (membershipId: string | null): string | null => {
    if (membershipId === null) return null
    const member = members.find((m) => m.membershipId === membershipId)
    return member?.email ?? null
  }

  return (
    <main className="shell">
      <SiteNav current="handoffs" counts={counts} />
      <h1>Handoff queue</h1>
      <p className="muted">
        Conversations the agent could not finish. Accepting one assigns the conversation to you.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem' }}>
        <Link className="button secondary" href="/handoffs">Unclaimed</Link>
        <Link className="button secondary" href="/handoffs?mine=all">All open</Link>
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
                  {h.escalatedAt !== null && (
                    /*
                     * Named, not just marked. "Escalated" on its own was true
                     * of a handoff that reached nobody for forty-five hours,
                     * and read exactly the same as one somebody was chasing.
                     */
                    <span className="tag">
                      {nameOf(h.escalatedToMembershipId) === null
                        ? 'escalated to nobody'
                        : `escalated to ${nameOf(h.escalatedToMembershipId)}`}
                    </span>
                  )}
                  <span className="tag">waiting {formatDuration(h.waitingSinceMinutes * 60)}</span>
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

                {/*
                  * Closing it, which nothing in the product could do. An accepted
                  * handoff had no end state reachable from any screen, so the queue
                  * only ever grew. Available whether or not somebody claimed it:
                  * insisting on Accept first is a second click on work already done.
                  */}
                <form
                  action={finishHandoff}
                  style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem', flexWrap: 'wrap' }}
                >
                  <input type="hidden" name="conversationId" value={h.conversationId} />
                  <input
                    className="input" name="resolution"
                    placeholder="What happened (for your records, never sent)"
                    style={{ flex: '1 1 14rem' }}
                  />
                  <button className="button secondary" type="submit">Done — hand it back</button>
                </form>
              </li>
            )
          })}
        </ul>
      )}

      {chases.length > 0 && (
        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Chases nobody could send</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            A follow-up became a task instead of a message — usually because it fell outside the
            24-hour window, or because the wording for that attempt was not written at the time.
            Nothing is sent for these. Write to them yourself, or let it go.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.5rem' }}>
            {chases.map((f) => (
              <li
                key={f.id}
                className="card"
                style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}
              >
                <span>
                  <strong>{f.customerName ?? f.whatsappNumber}</strong>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    {' '}· {f.state === 'needs_a_person' ? 'needs a person' : 'overdue'}
                    {f.minutesLate > 0 ? ` · ${formatDuration(f.minutesLate)} late` : ''}
                  </span>
                </span>
                <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <Link className="button secondary" href={`/conversations/${f.conversationId}`}>
                    Write to them
                  </Link>
                  <form action={dismissFollowUp}>
                    <input type="hidden" name="followUpId" value={f.id} />
                    <button className="button secondary" type="submit">Let it go</button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
