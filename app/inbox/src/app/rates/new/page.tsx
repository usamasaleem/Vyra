import Link from 'next/link'
import { getNavCounts } from '@vyra/db'
import { SiteNav } from '../../site-nav'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { AddCarForm } from './add-car-form'

/**
 * Adding a car.
 *
 * Its own page rather than a panel on Rates, because it is the first thing a
 * new operator does and the setup checklist sends them straight here.
 */
export const dynamic = 'force-dynamic'

export default async function AddCarPage() {
  const actor = await requireActor()
  const counts = await actorReads(actor, (run) => getNavCounts(run, actor.operatorId))

  return (
    <main className="shell">
      <SiteNav current="rates" counts={counts} />
      <p className="muted" style={{ margin: 0 }}><Link href="/rates">← Rates</Link></p>
      <h1>Add a car</h1>
      <p className="muted">
        The agent can offer and quote it as soon as you save. It is saved against your name, and
        the rate is the only price it will ever quote for this car.
      </p>

      {permissions.canAdminister(actor) ? (
        <AddCarForm />
      ) : (
        <p className="card muted">Only an administrator can add cars.</p>
      )}
    </main>
  )
}
