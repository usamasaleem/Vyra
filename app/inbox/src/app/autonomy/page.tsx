import Link from 'next/link'
import { getAutonomyState, getNavCounts } from '@vyra/db'
import { SiteNav } from '../site-nav'
import { SwitchForm } from './switch-form'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * One switch: the agent sells and books without waiting on anybody.
 *
 * It only turns on when the checklist says the agent will not need to stop and
 * ask — every answer written, the calendar kept, a ceiling set, and somebody's
 * phone that hears about the rare thing a person still has to handle.
 */
export default async function AutonomyPage() {
  const actor = await requireActor()
  const [counts, state] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    getAutonomyState(run, actor.operatorId),
  ]))
  const required = state.items.filter((i) => i.blocking)
  const better = state.items.filter((i) => !i.blocking && i.later !== true)
  const later = state.items.filter((i) => i.later === true)

  const row = (i: (typeof state.items)[number]) => (
    <li key={i.key} className="card" style={{ padding: '0.8rem 1rem' }}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span aria-hidden style={{ color: i.done ? 'var(--ok)' : i.later ? 'var(--muted)' : 'var(--danger)' }}>
          {i.done ? '✓' : i.later ? '•' : '✗'}
        </span>
        <strong>{i.title}</strong>
        {i.href !== null && !i.done && <Link href={i.href} style={{ fontSize: '0.88rem' }}>Fix</Link>}
      </div>
      {i.detail !== null && <div style={{ fontSize: '0.9rem', marginTop: '0.2rem' }}>{i.detail}</div>}
      <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>{i.why}</div>
    </li>
  )
  const list = (items: typeof state.items) => (
    <ul style={{ listStyle: 'none', padding: 0, margin: '0.6rem 0 0', display: 'grid', gap: '0.5rem' }}>
      {items.map(row)}
    </ul>
  )

  return (
    <main className="shell">
      <SiteNav current="autonomy" counts={counts} />
      <h1>Autonomous</h1>
      <p className="muted">
        When this is on, the agent answers, sells and books without waiting for anybody: bookings up to
        your ceiling are confirmed, and its answer on price is final — your tiers, the tier a longer
        rental would reach, or a cheaper car, and nothing beyond them. Accidents, disputes and anyone who
        insists on a person still come to you, and your phone is told.
      </p>

      <section className="card" style={{ margin: '1rem 0', borderLeft: `3px solid ${state.on ? 'var(--ok)' : 'var(--accent)'}` }}>
        <p style={{ marginTop: 0 }}>
          Autonomous is <strong>{state.on ? 'on' : 'off'}</strong>
          {state.setAt !== null && state.setBy !== null && (
            <span className="muted"> — switched {state.on ? 'on' : 'off'} by {state.setBy},{' '}
              {state.setAt.toISOString().slice(0, 16).replace('T', ' ')}</span>
          )}
        </p>
        <SwitchForm on={state.on} ready={state.missing === 0} canEdit={permissions.canAdminister(actor)} />
      </section>

      <h2 style={{ fontSize: '1.05rem' }}>Required ({required.filter((i) => i.done).length} of {required.length})</h2>
      {list(required)}

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Makes it better</h2>
      {list(better)}

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Still with your team for now</h2>
      {list(later)}
    </main>
  )
}
