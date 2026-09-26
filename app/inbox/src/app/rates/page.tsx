import Link from 'next/link'
import { SiteNav } from '../site-nav'
import { getNavCounts, listRates } from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { RateForm } from './rate-form'
import { PhotoForm } from './photo-form'
import { HighlightForm } from './highlight-form'

/**
 * Rates, the last thing standing between the agent and a price.
 *
 * Every confirmed vehicle appears, including the ones with no rate — a missing
 * rate is the reason the agent refuses to quote, and a page listing only what
 * exists cannot show what does not.
 */
export const dynamic = 'force-dynamic'

export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string }>
}) {
  const { added } = await searchParams
  const actor = await requireActor()
  const [counts, rates] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listRates(run, actor.operatorId),
  ]))
  const canEdit = permissions.canAdminister(actor)
  const unpriced = rates.filter((r) => r.dailyRateMinor === null).length

  /**
   * The line-up needs two photographed cars, and says so here.
   *
   * "What have you got?" answers with a picture of each car, and the reply
   * falls back to a text list below two of them. The operator had one car with
   * photographs and no way to know that was the reason — the feature was simply
   * absent, which is indistinguishable from not existing.
   */
  const photographed = rates.filter((r) => r.photoUrls.length > 0).length

  return (
    <main className="shell">
      <SiteNav current="rates" counts={counts} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <h1>Rates</h1>
        {canEdit && <Link className="button" href="/rates/new">Add a car</Link>}
      </div>
      <p className="muted">
        The agent prices from these and from nothing else. A vehicle with no rate cannot be
        quoted — it says so rather than estimating. Photo links are sent to a customer asking
        about that car.
      </p>

      {added !== undefined && rates.some((r) => r.vehicleId === added) && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          Saved. The agent can offer and quote{' '}
          <strong>{rates.find((r) => r.vehicleId === added)!.vehicleLabel}</strong> from now on.
        </p>
      )}

      {unpriced > 0 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          {unpriced} vehicle{unpriced === 1 ? ' has' : 's have'} no rate. The agent will refuse to
          quote {unpriced === 1 ? 'it' : 'them'}.
        </p>
      )}

      {rates.length > 0 && photographed < 2 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          {photographed === 0
            ? 'No car has photographs.'
            : 'One car has photographs.'}{' '}
          A customer asking what you have is answered with a picture of each car once two of
          them have one — until then they get a list of names.
        </p>
      )}

      {rates.length === 0 ? (
        <p className="card muted">
          No cars yet.{canEdit && <> <Link href="/rates/new">Add your first car</Link> to let the agent offer it.</>}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'grid', gap: '0.8rem' }}>
          {rates.map((r) => (
            <li key={r.vehicleId} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <strong>{r.vehicleLabel}</strong>
                {r.highlight !== null && (
                  <span className="tag">{r.highlight}</span>
                )}
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
                  <PhotoForm vehicleId={r.vehicleId} current={r.photoUrls} />
                  <HighlightForm vehicleId={r.vehicleId} current={r.highlight} />
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
