'use client'

import { useActionState, useState } from 'react'
import { cancelConfirmedBooking, type DecisionState } from './actions'

/**
 * Folded away until it is wanted.
 *
 * Cancelling a confirmed rental is rare and expensive, and a button sitting
 * open beside every row in the diary is one mis-click from a customer being
 * told their car is gone.
 */
export function CancelForm({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(
    cancelConfirmedBooking, { error: null },
  )
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button className="button secondary" type="button" onClick={() => setOpen(true)}>
        Cancel this booking
      </button>
    )
  }

  return (
    <form action={action} className="stack" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <label className="label" htmlFor={`cancel-${bookingId}`}>
        What they are told, word for word
      </label>
      <textarea id={`cancel-${bookingId}`} className="input" name="message" rows={3} />
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <label className="label" htmlFor={`cancel-note-${bookingId}`}>
            Note for your team (optional, never sent)
          </label>
          <input id={`cancel-note-${bookingId}`} className="input" name="note" />
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Cancelling…' : 'Cancel and tell them'}
        </button>
        <button className="button secondary" type="button" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
        The car goes back on the calendar and can be sold to somebody else.
      </p>
      {state.error !== null && <p className="notice">{state.error}</p>}
    </form>
  )
}
