'use client'

import { useActionState } from 'react'
import { markUnavailable, type BlockState } from './actions'

export function BlockForm({ vehicles }: { vehicles: Array<{ id: string; label: string }> }) {
  const [state, action, pending] = useActionState<BlockState, FormData>(markUnavailable, { error: null })

  return (
    <form action={action} className="card stack" style={{ gap: '0.6rem' }}>
      <strong>Mark a car unavailable</strong>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.6rem' }}>
        <label style={{ fontSize: '0.82rem' }}>
          Car
          <select className="input" name="vehicleId" style={{ marginTop: '0.2rem' }}>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>

        <label style={{ fontSize: '0.82rem' }}>
          From
          <input className="input" name="startDate" type="date" required style={{ marginTop: '0.2rem' }} />
        </label>

        <label style={{ fontSize: '0.82rem' }}>
          To
          <input className="input" name="endDate" type="date" style={{ marginTop: '0.2rem' }} />
        </label>

        <label style={{ fontSize: '0.82rem' }}>
          Why
          <select className="input" name="reason" style={{ marginTop: '0.2rem' }}>
            <option value="booked">Booked</option>
            <option value="maintenance">Maintenance</option>
            <option value="held">Held</option>
            <option value="other">Other</option>
          </select>
        </label>
      </div>

      <label style={{ fontSize: '0.82rem' }}>
        Note, if it helps
        <input className="input" name="note" placeholder="Optional" style={{ marginTop: '0.2rem' }} />
      </label>

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Mark unavailable'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Both dates included. The agent stops offering the car for them straight away.
        </span>
        {state.error !== null && <span className="notice">{state.error}</span>}
      </div>
    </form>
  )
}
