'use client'

import { useActionState, useRef } from 'react'
import { sendReply } from '@/app/actions'

export function ReplyForm({ conversationId }: { conversationId: string }) {
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
        <label className="label" htmlFor="body">Reply as the business</label>
        <textarea className="input" id="body" name="body" rows={3} required />
      </div>
      {state.error !== null && <p className="notice">{state.error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Queueing…' : 'Send'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Queued for the dispatcher, which re-checks the 24-hour window before sending.
        </span>
      </div>
    </form>
  )
}
