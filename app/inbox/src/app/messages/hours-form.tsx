'use client'

import { useActionState } from 'react'
import { saveServiceHours, type MessageState } from './actions'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * When somebody is there, as something a clock can be compared to.
 *
 * The prose answer on the Answers screen is what a customer is told. This is
 * what the system knows, and the two are allowed to differ: one is a sentence,
 * and only the other can be compared to the time it is now.
 *
 * A day left blank is a day they are shut. Blank everywhere means nobody has
 * said — and an operator who has not said is never treated as closed, because
 * telling a customer the office is shut is a claim about their business.
 */
export function HoursForm({ current }: { current: Record<string, { open: string; close: string } | undefined> | null }) {
  const [state, action, pending] = useActionState<MessageState, FormData>(
    saveServiceHours, { error: null },
  )

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <div style={{ display: 'grid', gap: '0.4rem' }}>
        {DAYS.map((day, index) => {
          const value = current?.[String(index)]
          return (
            <div key={day} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <span style={{ width: '6rem', fontSize: '0.88rem' }}>{day}</span>
              <input
                className="input" type="time" name={`open-${index}`}
                defaultValue={value?.open ?? ''} aria-label={`${day} opens`}
                style={{ width: '8rem' }}
              />
              <span className="muted">to</span>
              <input
                className="input" type="time" name={`close-${index}`}
                defaultValue={value?.close ?? ''} aria-label={`${day} closes`}
                style={{ width: '8rem' }}
              />
            </div>
          )
        })}
      </div>

      <p className="muted" style={{ fontSize: '0.82rem', margin: 0 }}>
        Leave a day blank to close it. Leave every day blank and the out-of-hours message
        never sends — nobody is assumed to be shut.
      </p>

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="button secondary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save hours'}
        </button>
        {state.error !== null && <span className="notice">{state.error}</span>}
        {state.saved === 'hours' && state.error === null && (
          <span className="muted" style={{ fontSize: '0.85rem' }}>Saved.</span>
        )}
      </div>
    </form>
  )
}
