'use client'

import { useActionState } from 'react'
import { claimHandoff } from '../actions'

/**
 * Accepting is a form, not a link.
 *
 * A GET that changes ownership would be followed by any prefetch or crawler,
 * and a shared queue is exactly where an accidental claim costs something: the
 * item leaves everyone else's view and a customer waits on someone who never
 * meant to take it.
 */
export function AcceptButton({ handoffId }: { handoffId: string }) {
  const [state, action, pending] = useActionState(claimHandoff, { error: null })

  return (
    <form action={action} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <input type="hidden" name="handoffId" value={handoffId} />
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Accepting…' : 'Accept'}
      </button>
      {/*
        Losing the race is ordinary in a shared queue, so it reads as
        information rather than an error someone did wrong.
      */}
      {state.error !== null && (
        <span className="muted" style={{ fontSize: '0.82rem' }}>{state.error}</span>
      )}
    </form>
  )
}
