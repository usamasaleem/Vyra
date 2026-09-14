import { SiteNav } from '../site-nav'
import { listRates } from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'
import { RateForm } from './rate-form'

/**
 * Rates, the last thing standing between the agent and a price.
 *
 * Every confirmed vehicle appears, including the ones with no rate — a missing
 * rate is the reason the agent refuses to quote, and a page listing only what
 * exists cannot show what does not.
 */
export const dynamic = 'force-dynamic'

export default async function RatesPage() {
  const actor = await requireActor()
  const rates = await listRates(queryRunner(), actor.operatorId)
  const canEdit = permissions.canAdminister(actor)
  const unpriced = rates.filter((r) => r.dailyRateMinor === null).length

  return (
    <main className="shell">
      <SiteNav current="rates" operatorId={actor.operatorId} />
      <h1>Rates</h1>
      <p className="muted">
        The agent prices from these and from nothing else. A vehicle with no rate cannot be
        quoted — it says so rather than estimating.
      </p>

      {unpriced > 0 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent, #b45309)' }}>
          {unpriced} vehicle{unpriced === 1 ? ' has' : 's have'} no rate. The agent will refuse to
          quote {unpriced === 1 ? 'it' : 'them'}.
        </p>
      )}

      {rates.length === 0 ? (
        <p className="card muted">No confirmed vehicles yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'grid', gap: '0.8rem' }}>
          {rates.map((r) => (
            <li key={r.vehicleId} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <strong>{r.vehicleLabel}</strong>
                {r.confirmedBy !== null && (
                  <span className="muted" style={{ fontSize: '0.78rem' }}>set by {r.confirmedBy}</span>
                )}
              </div>

              {r.dailyRateMinor === null && (
                <p className="muted" style={{ margin: '0.3rem 0 0.6rem' }}>No rate set.</p>
              )}

              {canEdit ? (
                <div style={{ marginTop: '0.6rem' }}>
                  <RateForm vehicleId={r.vehicleId} current={r} />
                </div>
              ) : (
                <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.85rem' }}>
                  Only an administrator can change rates.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
