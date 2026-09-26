import {
  CAR_STATUSES, getNavCounts, listAvailability, listCarsOffTheRoad, listRates, UNTIL_FURTHER_NOTICE,
} from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { BlockForm } from './block-form'
import { StatusForm } from './status-form'
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
  held: 'Held',
  other: 'Unavailable',
  ...CAR_STATUSES,
}

/** "Mon 29 Sep": the day as the team says it. */
function spoken(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

export default async function AvailabilityPage() {
  const actor = await requireActor()
  const [counts, allBlocks, rates, offTheRoad, operator] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listAvailability(run, actor.operatorId),
    listRates(run, actor.operatorId),
    listCarsOffTheRoad(run, actor.operatorId),
    run(`select availability_calendar_complete as complete from operators where id = $1`,
      [actor.operatorId]),
  ]))

  const complete = operator[0]?.['complete'] === true
  const canEdit = permissions.canReply(actor)
  const vehicles = rates.map((r) => ({ id: r.vehicleId, label: r.vehicleLabel }))
  // A car off the road today is listed once, under its status, not again below.
  const current = new Set(offTheRoad.map((o) => o.blockId))
  const blocks = allBlocks.filter((b) => !current.has(b.id))

  return (
    <main className="shell">
      <SiteNav current="availability" counts={counts} />
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

      {/*
        The cars that cannot go out today. Loud on purpose when there is no
        date back: nothing else will remind anybody that the car is still
        off sale.
      */}
      <h2 style={{ fontSize: '1.05rem', marginTop: '1.75rem' }}>Off the road</h2>
      {offTheRoad.length === 0 ? (
        <p className="card muted">Every car can go out today.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.6rem' }}>
          {offTheRoad.map((o) => (
            <li key={o.blockId} className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <strong>{o.vehicleLabel}</strong> — {CAR_STATUSES[o.status]}
                {o.backOn === null ? ', no date back' : ` until ${spoken(o.backOn)}`}
                <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
                  {o.backOn === null
                    ? 'Not offered to anyone until you put it back.'
                    : `Offered again from ${spoken(o.backOn)}.`}
                  {' '}Since {spoken(o.since)} · recorded by {o.recordedBy}
                  {o.note === null ? '' : ` · ${o.note}`}
                </div>
              </div>
              {canEdit && (
                <form action={releaseBlock}>
                  <input type="hidden" name="blockId" value={o.blockId} />
                  <button className="button secondary" type="submit">Back on the road</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && vehicles.length > 0 && (
        <div style={{ marginTop: '0.8rem' }}>
          <StatusForm
            vehicles={vehicles}
            statuses={Object.entries(CAR_STATUSES).map(([value, label]) => ({ value, label }))}
          />
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
                  {REASON_LABEL[b.reason] ?? b.reason} · {b.startDate} to {b.endDate === UNTIL_FURTHER_NOTICE ? 'further notice' : b.endDate} · recorded by {b.recordedBy}
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
