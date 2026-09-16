import { listAvailability, listRates } from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { BlockForm } from './block-form'
import { releaseBlock, setCalendarIsComplete } from './actions'

/**
 * When each car is taken.
 *
 * The other half of availability was already here and is reactive: the agent
 * asks, a person answers, the answer expires. One answer had been given against
 * dozens of dated enquiries, because it costs somebody's attention every time.
 *
 * A booking recorded once answers every enquiry that touches it, and keeps
 * answering.
 */
export const dynamic = 'force-dynamic'

const REASON_LABEL: Record<string, string> = {
  booked: 'Booked',
  maintenance: 'Maintenance',
  held: 'Held',
  other: 'Unavailable',
}

export default async function AvailabilityPage() {
  const actor = await requireActor()
  const run = actorRunner(actor)

  const [blocks, rates, operator] = await Promise.all([
    listAvailability(run, actor.operatorId),
    listRates(run, actor.operatorId),
    run(`select availability_calendar_complete as complete from operators where id = $1`,
      [actor.operatorId]),
  ])

  const complete = operator[0]?.['complete'] === true
  const canEdit = permissions.canReply(actor)
  const vehicles = rates.map((r) => ({ id: r.vehicleId, label: r.vehicleLabel }))

  return (
    <main className="shell">
      <SiteNav current="availability" actor={actor} />
      <h1>When cars are taken</h1>
      <p className="muted">
        A booking recorded here answers every enquiry that touches those dates, without anyone
        being asked again.
      </p>

      {/*
        The claim that changes what the agent will promise. Stated by a person,
        never inferred: with it off, an empty calendar means nobody wrote
        anything down, which is not the same as the car being free.
      */}
      <div className="card" style={{ marginTop: '1.25rem' }}>
        <strong>{complete ? 'An empty calendar means the car is free' : 'An empty calendar means nobody has checked'}</strong>
        <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.88rem' }}>
          {complete
            ? 'The agent tells customers a car is available when nothing is booked against it. That is only true while this calendar is kept current.'
            : 'The agent answers "no" from a booking below, and sends everything else to a person. Turn this on once every booking is recorded here — not before.'}
        </p>
        {permissions.canAdminister(actor) && (
          <form action={setCalendarIsComplete} style={{ marginTop: '0.8rem' }}>
            <input type="hidden" name="complete" value={String(!complete)} />
            <button className="button secondary" type="submit">
              {complete ? 'We do not keep it current' : 'We keep this calendar current'}
            </button>
          </form>
        )}
      </div>

      {canEdit && vehicles.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <BlockForm vehicles={vehicles} />
        </div>
      )}

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.75rem' }}>Coming up</h2>
      {blocks.length === 0 ? (
        <p className="card muted">
          Nothing recorded. Every dated enquiry goes to a person until something is.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.6rem' }}>
          {blocks.map((b) => (
            <li key={b.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <strong>{b.vehicleLabel}</strong>
                <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
                  {REASON_LABEL[b.reason] ?? b.reason} · {b.startDate} to {b.endDate} · recorded by {b.recordedBy}
                  {b.note === null ? '' : ` · ${b.note}`}
                </div>
              </div>
              {canEdit && (
                <form action={releaseBlock}>
                  <input type="hidden" name="blockId" value={b.id} />
                  <button className="button secondary" type="submit">Release</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '1.5rem' }}>
        Releasing keeps the record. A booking that was cancelled can still explain why a customer
        was told no last week.
      </p>
    </main>
  )
}
