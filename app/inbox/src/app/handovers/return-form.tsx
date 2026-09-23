'use client'

import { useActionState } from 'react'
import { markCarReturned, type ReturnState } from './actions'

/** One press, with a name on it, and the thank-you after it. */
export function ReturnForm({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState<ReturnState, FormData>(
    markCarReturned, { error: null },
  )
  return (
    <form action={action} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <button className="button secondary" type="submit" disabled={pending}>
        {pending ? 'Recording…' : 'Mark returned'}
      </button>
      {state.error !== null && <span style={{ fontSize: '0.82rem' }}>{state.error}</span>}
      {state.notice !== undefined && <span className="muted" style={{ fontSize: '0.82rem' }}>{state.notice}</span>}
    </form>
  )
}
