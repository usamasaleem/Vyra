'use client'

import { useActionState, useRef, useState } from 'react'
import { saveAutomatedMessage, type MessageState } from './actions'

/**
 * One message, one box, one name — the same shape as an answer, because it
 * carries the same weight. This goes to a customer with nobody watching.
 *
 * The starter is offered, never filled in. An empty box is what four of these
 * stayed for the whole pilot, so there is a draft a click away; but the click
 * is the point. Nothing is pre-written into the field, because a field that
 * arrives full is a field somebody publishes without reading, and then the
 * greeting every new customer gets is ours rather than theirs.
 */
export function MessageForm({
  topic,
  current,
  starter,
}: {
  topic: string
  current: string | null
  starter: string
}) {
  const [state, action, pending] = useActionState<MessageState, FormData>(
    saveAutomatedMessage, { error: null },
  )
  const box = useRef<HTMLTextAreaElement>(null)
  const [blank, setBlank] = useState(current === null || current.trim() === '')

  /** Fill it in, put the cursor at the end, and get out of the way. */
  function useTheDraft() {
    const el = box.current
    if (el === null) return
    el.value = starter
    setBlank(false)
    el.focus()
    el.setSelectionRange(starter.length, starter.length)
  }

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="topic" value={topic} />

      <label className="label" htmlFor={`message-${topic}`}>
        The message, word for word
      </label>
      <textarea
        ref={box}
        id={`message-${topic}`}
        className="input"
        name="answer"
        rows={3}
        defaultValue={current ?? ''}
        placeholder={starter}
        onChange={(event) => setBlank(event.target.value.trim() === '')}
      />

      {blank && (
        <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
          Nothing to say yet?{' '}
          <button
            type="button"
            onClick={useTheDraft}
            style={{
              background: 'none', border: 'none', padding: 0, font: 'inherit',
              color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer',
            }}
          >
            Start from a draft
          </button>{' '}
          and make it sound like you. It is not sent until you do.
        </p>
      )}

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
