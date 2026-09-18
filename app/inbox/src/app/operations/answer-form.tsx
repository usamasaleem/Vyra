'use client'

import { useActionState } from 'react'
import { answerOperations } from '../actions'

/**
 * The form a person answers from.
 *
 * Source is required and has no default. Section 6: "An answer carries its
 * source and the time it was checked. An answer without a time checked cannot
 * be given to a customer." A pre-filled source would be a lie with a plausible
 * shape, and the whole point of the field is that it can be audited later.
 *
 * "Checked how long ago" exists because people answer from what they saw a
 * moment before opening this page, and recording it as now would tell a
 * customer the answer is fresher than it is.
 */
export function AnswerForm({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState(answerOperations, { error: null })

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="requestId" value={requestId} />

      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {(
          [
            ['available', 'Available'],
            ['unavailable', 'Not available'],
            ['pending_confirmation', 'Depends on another booking'],
            ['unknown', 'Could not tell'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="tag" style={{ cursor: 'pointer' }}>
            <input type="radio" name="answer" value={value} required style={{ marginRight: '0.35rem' }} />
            {label}
          </label>
        ))}
      </div>

      <label style={{ fontSize: '0.85rem' }}>
        Where did you check?
        <input
          name="source"
          required
          placeholder="fleet calendar, called the yard, booking system…"
          style={{ width: '100%', marginTop: '0.2rem' }}
        />
      </label>

      <label style={{ fontSize: '0.85rem' }}>
        Checked how many minutes ago?
        <input
          name="checkedMinutesAgo"
          type="number"
          min={0}
          defaultValue={0}
          style={{ width: '6rem', marginTop: '0.2rem', display: 'block' }}
        />
      </label>

      <label style={{ fontSize: '0.85rem' }}>
        Anything the salesperson should know (optional)
        <input name="note" style={{ width: '100%', marginTop: '0.2rem' }} />
      </label>

      {/*
        * And what the customer is told, which nothing sent.
        *
        * Seven of these were answered during the pilot and not one reached the
        * person waiting on WhatsApp: the queue emptied and the conversation did
        * not move, which from the customer's side is the same as nobody having
        * looked. Optional, because a salesperson may prefer to phrase it in the
        * thread — but it is here, so the ordinary case is one action.
        */}
      <label style={{ display: 'block', marginTop: '0.6rem' }}>
        Tell the customer (optional — sent as you, signed)
        <textarea
          className="input" name="reply" rows={2}
          placeholder="Yes, that one is free for those dates."
          style={{ width: '100%', marginTop: '0.2rem' }}
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record answer'}
        </button>
        {state.error !== null && (
          <span className="muted" style={{ fontSize: '0.82rem' }}>{state.error}</span>
        )}
      </div>
    </form>
  )
}
