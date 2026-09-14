'use client'

import { useActionState } from 'react'
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
}: {
  topic: string
  current: string | null
  placeholder: string
}) {
  const [state, action, pending] = useActionState<AnswerState, FormData>(saveAnswer, { error: null })

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="topic" value={topic} />

      <label className="label" htmlFor={`answer-${topic}`}>
        The answer, in your own words
      </label>
      <textarea
        id={`answer-${topic}`}
        className="input"
        name="answer"
        rows={3}
        defaultValue={current ?? ''}
        placeholder={placeholder}
      />

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
