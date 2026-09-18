'use client'

import { useActionState } from 'react'
import { useState } from 'react'
import { approveAndSendQuote, discountAndSendQuote } from '../actions'

/**
 * Approving is the moment a figure becomes something the operator owes, so the
 * whole quote is on screen and the revision travels with the click.
 *
 * The hidden revision is what makes the approval version-bound: if the agent
 * reprices while this page is open, the click is refused rather than approving
 * numbers nobody read.
 */
export function ApproveQuote({
  quoteId,
  revision,
  currency,
}: {
  quoteId: string
  revision: number
  currency: string
}) {
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
      <DiscountQuote quoteId={quoteId} revision={revision} currency={currency} />
    </form>
  )
}

/**
 * Sending a different number, which was the one thing this screen could not do.
 *
 * A salesperson looking at a quote either sends it or wants it to be something
 * else, and there was no second option — so a discount could only be typed
 * into a message, leaving the record saying one figure while the customer held
 * another. Folded away, because most quotes go out as calculated and an open
 * discount box beside every one of them is an invitation.
 */
function DiscountQuote({
  quoteId,
  revision,
  currency,
}: {
  quoteId: string
  revision: number
  currency: string
}) {
  const [state, action, pending] = useActionState(discountAndSendQuote, { error: null })
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: 'none', border: 'none', padding: 0, font: 'inherit',
          color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer',
        }}
      >
        Send it for less
      </button>
    )
  }

  return (
    <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
      {/* quoteId and revision come from the surrounding form, which already carries them. */}
      <label className="label" htmlFor={`discount-${quoteId}`} style={{ margin: 0 }}>
        Take off ({currency})
      </label>
      <input
        className="input" id={`discount-${quoteId}`} name="discount"
        type="number" inputMode="numeric" min={1} step={1}
        style={{ width: '7rem' }}
      />
      <input
        className="input" name="reason" placeholder="Why (never sent to them)"
        style={{ flex: '1 1 12rem' }}
      />
      <button className="button" type="submit" formAction={action} disabled={pending}>
        {pending ? 'Sending…' : 'Apply and send'}
      </button>
      <button className="button secondary" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {state.error !== null && (
        <span style={{ fontSize: '0.82rem', flexBasis: '100%' }}>{state.error}</span>
      )}
    </span>
  )
}
