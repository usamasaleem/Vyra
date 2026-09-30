import Link from 'next/link'
import { getNavCounts } from '@vyra/db'
import { SiteNav } from '../../site-nav'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { ImportFleetForm } from './import-fleet-form'

/**
 * Bringing a fleet in from a spreadsheet.
 *
 * For the operator whose cars already live in Excel: upload, check what was
 * understood, then import. Photos are added afterwards from the Rates page.
 */
export const dynamic = 'force-dynamic'

export default async function ImportFleetPage() {
  const actor = await requireActor()
  const counts = await actorReads(actor, (run) => getNavCounts(run, actor.operatorId))

  return (
    <main className="shell">
      <SiteNav current="rates" counts={counts} />
      <p className="muted" style={{ margin: 0 }}><Link href="/rates">← Rates</Link></p>
      <h1>Import your fleet</h1>
      <p className="muted">
        Upload an Excel (.xlsx) or CSV file with one car per row. You see what was read before
        anything is saved. Each car needs a make, model, year, colour, category, plate, chassis
        number and daily rate; deposit, variant and seats are optional. Nothing is guessed: a row
        missing something is listed so you can fix the sheet and upload it again.
      </p>

      {permissions.canAdminister(actor) ? (
        <ImportFleetForm />
      ) : (
        <p className="card muted">Only an administrator can add cars.</p>
      )}
    </main>
  )
}
