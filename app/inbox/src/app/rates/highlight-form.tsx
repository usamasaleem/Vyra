'use client'

import { useActionState } from 'react'
import { HIGHLIGHT_LIMIT } from '@vyra/contracts'
import { saveHighlight, type HighlightState } from '../actions'

/**
 * A few words beside a car, in the operator's own voice.
 *
 * Set rather than computed on purpose. "Best seller" is a factual claim about
 * the business, and the alternative — counting bookings — means "the one we
 * photographed" until there is real history, which would put a number we
 * invented into the operator's mouth.
 *
 * Short because of where it lands: a WhatsApp list row gives 72 characters of
 * description and the colour, engine and rate already use about fifty. There
 * is no badge or tag on that surface; Flows have them, and Meta will not let
 * this business use Flows.
 */
export function HighlightForm({
  vehicleId, current,
}: {
  vehicleId: string
  current: string | null
}) {
  const [state, action, pending] = useActionState<HighlightState, FormData>(
    saveHighlight, { error: null },
  )

  return (
    <form
      action={action}
      style={{ display: 'flex', gap: '0.4rem', alignItems: 'end', marginTop: '0.9rem', flexWrap: 'wrap' }}
    >
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <div style={{ flex: '1 1 14rem' }}>
        <label className="label" htmlFor={`highlight-${vehicleId}`}>
          A few words beside this car
        </label>
        <input
          className="input"
          id={`highlight-${vehicleId}`}
          name="highlight"
          defaultValue={current ?? ''}
          maxLength={HIGHLIGHT_LIMIT}
          placeholder="Best seller"
        />
        <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
          Shown first in the tappable list a customer sees, in your words. {HIGHLIGHT_LIMIT} characters.
          Leave it blank for none.
        </p>
      </div>
      <button className="button secondary" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state.error !== null && <p className="notice" style={{ margin: 0 }}>{state.error}</p>}
    </form>
  )
}
