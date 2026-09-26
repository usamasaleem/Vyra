'use client'

import { useActionState } from 'react'
import { saveSeason, type SeasonState } from '../actions'

/**
 * Adding a season: a name, the first and last day, and how much it changes
 * the price.
 *
 * A percentage rather than a second price per car, because that is how an
 * operator already thinks about December — "twenty percent more" — and one
 * season can then cover the whole fleet instead of being typed in per car.
 */
export function SeasonForm({ cars }: { cars: Array<{ vehicleId: string; vehicleLabel: string }> }) {
  const [state, action, pending] = useActionState<SeasonState, FormData>(saveSeason, { error: null })

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.6rem' }}>
        <label style={{ fontSize: '0.82rem', display: 'block' }}>
          Name
          <input className="input" name="name" required maxLength={60} placeholder="Peak season" style={{ marginTop: '0.2rem' }} />
        </label>
        <label style={{ fontSize: '0.82rem', display: 'block' }}>
          First day
          <input className="input" name="startDate" type="date" required style={{ marginTop: '0.2rem' }} />
        </label>
        <label style={{ fontSize: '0.82rem', display: 'block' }}>
          Last day
          <input className="input" name="endDate" type="date" required style={{ marginTop: '0.2rem' }} />
        </label>
        <label style={{ fontSize: '0.82rem', display: 'block' }}>
          Price change (%)
          <input
            className="input" name="percent" type="number" step="1" min={-90} max={300} required
            placeholder="20" style={{ marginTop: '0.2rem' }}
          />
        </label>
        <label style={{ fontSize: '0.82rem', display: 'block' }}>
          Applies to
          <select className="input" name="vehicleId" defaultValue="" style={{ marginTop: '0.2rem' }}>
            <option value="">All cars</option>
            {cars.map((c) => <option key={c.vehicleId} value={c.vehicleId}>{c.vehicleLabel}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add season'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          20 is 20% more, -15 is 15% off. Applied to the days of a rental inside the season, on top of
          the day, week or month price.
        </span>
        {state.error !== null && <span style={{ fontSize: '0.82rem' }}>{state.error}</span>}
        {state.error === null && state.saved === true && <span style={{ fontSize: '0.82rem' }}>Saved.</span>}
      </div>
    </form>
  )
}
