'use client'

import { useActionState, useState } from 'react'
import { answerBooking, type DecisionState } from './actions'

/**
 * Yes or no, and what the customer is told, in one step.
 *
 * Two buttons and a box rather than a confirm dialog: the decision and the
 * sentence are the same act, and separating them is how a booking gets marked
 * confirmed while the person who committed to it hears nothing.
 */
export function BookingForm({
  bookingId,
  confirmDraft,
  declineDraft,
}: {
  bookingId: string
  confirmDraft: string
  declineDraft: string
}) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(
    answerBooking, { error: null },
  )
  const [decision, setDecision] = useState<'confirmed' | 'declined'>('confirmed')

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem', marginTop: '0.9rem' }}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="decision" value={decision} />

      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={decision === 'confirmed' ? 'button' : 'button secondary'}
          onClick={() => setDecision('confirmed')}
        >
          Confirmed
        </button>
        <button
          type="button"
          className={decision === 'declined' ? 'button' : 'button secondary'}
          onClick={() => setDecision('declined')}
        >
          Cannot take it
        </button>
      </div>

      <label className="label" htmlFor={`message-${bookingId}`}>
        What they are told, word for word
      </label>
      <textarea
        key={decision}
        id={`message-${bookingId}`}
        className="input"
        name="message"
        rows={3}
        defaultValue={decision === 'confirmed' ? confirmDraft : declineDraft}
      />

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <label className="label" htmlFor={`note-${bookingId}`}>
            Note for your team (optional, never sent)
          </label>
          <input id={`note-${bookingId}`} className="input" name="note" />
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Sending…' : decision === 'confirmed' ? 'Confirm and tell them' : 'Decline and tell them'}
        </button>
      </div>

      {state.error !== null && <p className="notice">{state.error}</p>}
    </form>
  )
}
