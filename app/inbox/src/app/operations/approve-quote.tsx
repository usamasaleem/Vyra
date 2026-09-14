'use client'

import { useActionState } from 'react'
import { approveAndSendQuote } from '../actions'

/**
 * Approving is the moment a figure becomes something the operator owes, so the
 * whole quote is on screen and the revision travels with the click.
 *
 * The hidden revision is what makes the approval version-bound: if the agent
 * reprices while this page is open, the click is refused rather than approving
 * numbers nobody read.
 */
export function ApproveQuote({ quoteId, revision }: { quoteId: string; revision: number }) {
  const [state, action, pending] = useActionState(approveAndSendQuote, { error: null })

  return (
    <form action={action} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
      <input type="hidden" name="quoteId" value={quoteId} />
      <input type="hidden" name="revision" value={revision} />
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Approve and send'}
      </button>
      <span className="muted" style={{ fontSize: '0.8rem' }}>
        Sends these exact figures to the customer.
      </span>
      {state.error !== null && (
        <span style={{ fontSize: '0.82rem' }}>{state.error}</span>
      )}
    </form>
  )
}
