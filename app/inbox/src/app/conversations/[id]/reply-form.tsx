'use client'

import { useActionState, useRef } from 'react'
import { sendReply } from '@/app/actions'

export function ReplyForm({
  conversationId,
  signAs,
}: {
  conversationId: string
  /** The name this will go out under. Null means it cannot be sent at all. */
  signAs: string | null
}) {
  const [state, formAction, pending] = useActionState(sendReply, { error: null })
  const formRef = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData)
        formRef.current?.reset()
      }}
      className="card stack"
    >
      <input type="hidden" name="conversationId" value={conversationId} />
      <div>
        <label className="label" htmlFor="body">
          {signAs === null ? 'Reply as the business' : `Reply as ${signAs}`}
        </label>
        <textarea className="input" id="body" name="body" rows={3} required disabled={signAs === null} />
      </div>
      {signAs === null && (
        <p className="notice">
          Your replies are signed with your name, so a customer can tell you from the
          assistant — and you have not set one yet. Add it on the <a href="/team">Team</a> page.
        </p>
      )}
      {state.error !== null && <p className="notice">{state.error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        <button className="button" type="submit" disabled={pending || signAs === null}>
          {pending ? 'Queueing…' : 'Send'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          {signAs === null
            ? 'Queued for the dispatcher, which re-checks the 24-hour window before sending.'
            : `Signed “— ${signAs}” and queued for the dispatcher, which re-checks the `
              + '24-hour window before sending.'}
        </span>
      </div>
    </form>
  )
}
