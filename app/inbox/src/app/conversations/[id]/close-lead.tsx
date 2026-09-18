'use client'

import { useActionState, useState } from 'react'
import { closeThisLead } from '@/app/actions'

/**
 * How a conversation ends, which nothing could record.
 *
 * Folded away, because most conversations are still live and a pair of
 * closing buttons beside every one of them invites a tidy-minded person to
 * end things that are not over.
 */
export function CloseLead({
  conversationId,
  lostReasons,
  closed,
}: {
  conversationId: string
  lostReasons: readonly string[]
  /** The stage it is already in, when somebody has closed it. */
  closed: string | null
}) {
  const [state, action, pending] = useActionState(closeThisLead, { error: null })
  const [outcome, setOutcome] = useState<'won' | 'lost' | null>(null)

  if (closed !== null) {
    return (
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        This lead is marked <strong>{closed}</strong>. Nothing here will chase them again.
      </p>
    )
  }

  if (outcome === null) {
    return (
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: '0.85rem' }}>How did this end?</span>
        <button className="button secondary" type="button" onClick={() => setOutcome('won')}>
          Won
        </button>
        <button className="button secondary" type="button" onClick={() => setOutcome('lost')}>
          Lost
        </button>
      </div>
    )
  }

  return (
    <form action={action} className="stack" style={{ gap: '0.5rem' }}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="outcome" value={outcome} />

      {outcome === 'lost' && (
        <div>
          <label className="label" htmlFor={`reason-${conversationId}`}>Why</label>
          <select className="input" id={`reason-${conversationId}`} name="reason" defaultValue="">
            <option value="" disabled>Pick the closest one</option>
            {lostReasons.map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <label className="label" htmlFor={`note-${conversationId}`}>
            Note (optional, never sent)
          </label>
          <input className="input" id={`note-${conversationId}`} name="note" />
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Closing…' : `Mark ${outcome}`}
        </button>
        <button className="button secondary" type="button" onClick={() => setOutcome(null)}>
          Cancel
        </button>
      </div>

      {state.error !== null && <p className="notice">{state.error}</p>}
    </form>
  )
}
