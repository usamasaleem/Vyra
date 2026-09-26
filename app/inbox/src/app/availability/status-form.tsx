'use client'

import { useActionState } from 'react'
import { setStatus, type StatusState } from './actions'

/**
 * A car off the road, in one step.
 *
 * The "back on" date is optional because often nobody knows — the garage has
 * not called — but the form says what leaving it empty means, since a car
 * nobody remembers to put back is a car quietly off sale.
 */
export function StatusForm({
  vehicles,
  statuses,
}: {
  vehicles: Array<{ id: string; label: string }>
  statuses: Array<{ value: string; label: string }>
}) {
  const [state, action, pending] = useActionState<StatusState, FormData>(
    setStatus, { error: null, warning: null },
  )

  return (
    <form action={action} className="card stack" style={{ gap: '0.6rem' }}>
      <strong>Take a car off the road</strong>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.6rem' }}>
        <label style={{ fontSize: '0.82rem' }}>
          Car
          <select className="input" name="vehicleId" style={{ marginTop: '0.2rem' }}>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>

        <label style={{ fontSize: '0.82rem' }}>
          Status
          <select className="input" name="status" style={{ marginTop: '0.2rem' }}>
            {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>

        <label style={{ fontSize: '0.82rem' }}>
          Back on
          <input className="input" name="backOn" type="date" style={{ marginTop: '0.2rem' }} />
        </label>
      </div>

      <label style={{ fontSize: '0.82rem' }}>
        Note, if it helps
        <input className="input" name="note" placeholder="Optional — for the team, never the customer" style={{ marginTop: '0.2rem' }} />
      </label>

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save status'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          From today. The agent stops offering it until the day it is back — with no date, until
          you put it back yourself.
        </span>
        {state.error !== null && <span className="notice">{state.error}</span>}
        {state.warning !== null && <span className="notice">{state.warning}</span>}
      </div>
    </form>
  )
}
