'use client'

import { useActionState } from 'react'
import { saveAutomatedMessage, type MessageState } from './actions'

/**
 * One message, one box, one name — the same shape as an answer, because it
 * carries the same weight. This goes to a customer with nobody watching.
 */
export function MessageForm({
  topic,
  current,
  placeholder,
}: {
  topic: string
  current: string | null
  placeholder: string
}) {
  const [state, action, pending] = useActionState<MessageState, FormData>(
    saveAutomatedMessage, { error: null },
  )

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="topic" value={topic} />

      <label className="label" htmlFor={`message-${topic}`}>
        The message, word for word
      </label>
      <textarea
        id={`message-${topic}`}
        className="input"
        name="answer"
        rows={3}
        defaultValue={current ?? ''}
        placeholder={placeholder}
      />

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <label className="label" htmlFor={`by-${topic}`}>Approved by</label>
          <input
            id={`by-${topic}`}
            className="input"
            name="confirmedBy"
            placeholder="Who at the operator approved this"
          />
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : current === null ? 'Turn it on' : 'Replace it'}
        </button>
      </div>

      {state.error !== null && <p className="notice">{state.error}</p>}
      {state.saved === topic && state.error === null && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Live. The next customer this applies to will get it.
        </p>
      )}
    </form>
  )
}
