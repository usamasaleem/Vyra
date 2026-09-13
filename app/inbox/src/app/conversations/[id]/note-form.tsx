'use client'

import { useActionState, useRef } from 'react'
import { addInternalNote } from '@/app/actions'

export function NoteForm({ conversationId }: { conversationId: string }) {
  const [state, formAction, pending] = useActionState(addInternalNote, { error: null })
  const formRef = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData)
        formRef.current?.reset()
      }}
      className="card stack"
      style={{ borderStyle: 'dashed' }}
    >
      <input type="hidden" name="conversationId" value={conversationId} />
      <div>
        <label className="label" htmlFor="note">Internal note</label>
        <textarea className="input" id="note" name="body" rows={2} required />
      </div>
      {state.error !== null && <p className="notice">{state.error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        <button className="button secondary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add note'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Visible to your team only. Never sent to the customer.
        </span>
      </div>
    </form>
  )
}
