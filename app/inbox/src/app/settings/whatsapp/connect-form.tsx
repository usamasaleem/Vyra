'use client'

import { useActionState } from 'react'
import { connectNumber, type ConnectState } from './actions'

export function ConnectForm({ hasNumber }: { hasNumber: boolean }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(
    connectNumber, { error: null, connected: false },
  )

  return (
    <form action={action} className="card stack">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>
        {hasNumber ? 'Replace the credentials' : 'Connect a number'}
      </h2>
      {hasNumber && (
        <p className="muted" style={{ fontSize: '0.83rem', marginTop: 0 }}>
          Connecting the same number again replaces its token, which is how you rotate one.
        </p>
      )}

      <div>
        <label className="label" htmlFor="phoneNumberId">Phone number id</label>
        <input className="input" id="phoneNumberId" name="phoneNumberId" inputMode="numeric" required />
      </div>
      <div>
        <label className="label" htmlFor="wabaId">WhatsApp Business Account id</label>
        <input className="input" id="wabaId" name="wabaId" inputMode="numeric" required />
      </div>
      <div>
        <label className="label" htmlFor="displayPhoneNumber">The number itself</label>
        <input className="input" id="displayPhoneNumber" name="displayPhoneNumber" placeholder="+971 50 000 0000" />
        <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
          Only so your team recognises it on this screen. Nothing is sent to it.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="accessToken">Access token</label>
        <input
          className="input" id="accessToken" name="accessToken" type="password"
          autoComplete="off" spellCheck={false} required
        />
        <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
          Encrypted before it is stored, and never shown again — only its last four characters. If
          you lose it, generate another and connect the number again.
        </p>
      </div>

      {state.error !== null && <p className="notice">{state.error}</p>}
      {state.connected && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Connected. Send a message to that number to check it arrives.
        </p>
      )}

      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  )
}
