'use client'

import { useActionState } from 'react'
import { connectStripe, type ConnectStripeState } from './actions'

export function ConnectStripeForm({ connected }: { connected: boolean }) {
  const [state, action, pending] = useActionState<ConnectStripeState, FormData>(connectStripe, { error: null, connected: false })
  return (
    <form action={action} className="stack">
      <div>
        <label className="label" htmlFor="secretKey">{connected ? 'Replace the secret key' : 'Stripe secret key'}</label>
        <input className="input" id="secretKey" name="secretKey" type="password" autoComplete="off"
          placeholder="sk_test_… or sk_live_…" required />
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0' }}>
          Stripe Dashboard → Developers → API keys. A test key (sk_test_) takes no real money — use it first.
        </p>
      </div>
      <div><button className="button" type="submit" disabled={pending}>{pending ? 'Checking with Stripe…' : 'Connect Stripe'}</button></div>
      {state.error !== null && <p className="notice" style={{ margin: 0 }}>{state.error}</p>}
      {state.connected && <p style={{ margin: 0 }}>Connected.</p>}
    </form>
  )
}
