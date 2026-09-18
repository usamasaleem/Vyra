import {
  AUTOMATED_MESSAGES, AUTOMATED_MESSAGE_LABELS, readServiceHours,
} from '@vyra/contracts'
import { getNavCounts, listKnowledge } from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { MessageForm } from './message-form'
import { HoursForm } from './hours-form'

/**
 * The messages the system sends when nobody is watching.
 *
 * Distinct from Answers, and the distinction is the point. That screen is what
 * the agent may say when a customer asks; this is what goes out with nobody
 * asking anything. The two were the same list, which is the likeliest reason
 * the follow-up wording sat unwritten while the follow-ups quietly became
 * tasks: it was filed under "what the agent may say" between the deposit and
 * the kilometre allowance, and it is not an answer to anything.
 *
 * Nothing here has a default. An operator who has not written a greeting has
 * no greeting and none is sent — the same rule as an unpublished policy
 * answer, for the same reason. Their voice is not ours to guess.
 */
export const dynamic = 'force-dynamic'

export default async function MessagesPage() {
  const actor = await requireActor()
  const [counts, entries, operator] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listKnowledge(run, actor.operatorId),
    run(`select service_hours from operators where id = $1`, [actor.operatorId]),
  ]))
  const canEdit = permissions.canAdminister(actor)

  /** The wording currently in force, by topic. */
  const live = new Map<string, string>()
  for (const row of entries) {
    const topic = row['topic'] as string
    if (row['published_at'] != null && row['effective_to'] == null && !live.has(topic)) {
      live.set(topic, row['answer'] as string)
    }
  }

  const hours = readServiceHours(operator[0]?.['service_hours'] ?? null)
  const unwritten = AUTOMATED_MESSAGES.filter((topic) => !live.has(topic))

  return (
    <main className="shell">
      <SiteNav current="messages" counts={counts} />
      <h1>Automated messages</h1>
      <p className="muted">
        Sent by the system with nobody watching, in your words and only your words. An
        unwritten message is not sent at all — nothing here is composed or guessed.
      </p>

      {unwritten.length > 0 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          {unwritten.length === AUTOMATED_MESSAGES.length
            ? 'Neither of these is written, so neither is sent.'
            : 'One of these is not written, so it is not sent.'}
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: '1.5rem 0 0', display: 'grid', gap: '1rem' }}>
        {AUTOMATED_MESSAGES.map((topic) => {
          const meta = AUTOMATED_MESSAGE_LABELS[topic]
          const current = live.get(topic) ?? null

          return (
            <li key={topic} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <strong>{meta.title}</strong>
                {current === null && <span className="tag">not sent</span>}
              </div>
              <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.88rem' }}>
                {meta.why}
              </p>

              {current !== null && (
                <p style={{ margin: '0.6rem 0 0', whiteSpace: 'pre-wrap' }}>{current}</p>
              )}

              {canEdit ? (
                <div style={{ marginTop: '0.9rem' }}>
                  <MessageForm topic={topic} current={current} placeholder={meta.placeholder} />
                </div>
              ) : (
                <p className="muted" style={{ margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
                  Only an administrator can change these.
                </p>
              )}
            </li>
          )
        })}

        <li className="card">
          <strong>When somebody is at the desk</strong>
          <p className="muted" style={{ margin: '0.4rem 0 0.9rem', fontSize: '0.88rem' }}>
            Used only to decide whether the out-of-hours message applies. The agent answers
            around the clock either way — these hours are about your people, not the system.
          </p>
          {canEdit ? (
            <HoursForm current={hours} />
          ) : (
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Only an administrator can change these.
            </p>
          )}
        </li>
      </ul>
    </main>
  )
}
