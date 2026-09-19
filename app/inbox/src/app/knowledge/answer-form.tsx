'use client'

import { useActionState, useRef, useState } from 'react'
import { saveAnswer, type AnswerState } from './actions'

/**
 * One topic, one box, one name.
 *
 * The name is not decoration and not an audit checkbox the operator can leave
 * blank: the database refuses to publish an answer without it, because a
 * published answer is quoted to customers as the company's position and
 * somebody has to have said it.
 */
export function AnswerForm({
  topic,
  current,
  placeholder,
  starter,
}: {
  topic: string
  current: string | null
  placeholder: string
  /**
   * Wording to begin from, for the topics whose facts are not the operator's
   * to invent. Null for everything priced, where a plausible invented figure
   * is the failure this system exists to prevent.
   */
  starter?: string | null
}) {
  const [state, action, pending] = useActionState<AnswerState, FormData>(saveAnswer, { error: null })
  const box = useRef<HTMLTextAreaElement>(null)
  const [blank, setBlank] = useState(current === null || current.trim() === '')

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="topic" value={topic} />

      <label className="label" htmlFor={`answer-${topic}`}>
        The answer, in your own words
      </label>
      <textarea
        ref={box}
        id={`answer-${topic}`}
        className="input"
        name="answer"
        rows={3}
        defaultValue={current ?? ''}
        placeholder={placeholder}
        onChange={(event) => setBlank(event.target.value.trim() === '')}
      />

      {blank && starter != null && starter !== '' && (
        <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
          There is{' '}
          <button
            type="button"
            onClick={() => {
              const el = box.current
              if (el === null) return
              el.value = starter
              setBlank(false)
              el.focus()
              el.setSelectionRange(starter.length, starter.length)
            }}
            style={{
              background: 'none', border: 'none', padding: 0, font: 'inherit',
              color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer',
            }}
          >
            wording to start from
          </button>. Fill in every <code>___</code> and check the rest before you publish —
          it will not save with a blank left in it, and nothing is quoted to anybody until
          you publish.
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <label className="label" htmlFor={`by-${topic}`}>Confirmed by</label>
          <input
            id={`by-${topic}`}
            className="input"
            name="confirmedBy"
            placeholder="Who at the operator said this"
          />
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : current === null ? 'Publish answer' : 'Replace answer'}
        </button>
      </div>

      {state.error !== null && <p className="notice">{state.error}</p>}
      {state.saved === topic && state.error === null && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Published. The agent can use this from its next reply.
        </p>
      )}
    </form>
  )
}
