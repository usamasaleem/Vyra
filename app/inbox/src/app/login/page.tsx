'use client'

import { useActionState } from 'react'
import { signIn } from './actions'

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, { error: null })

  return (
    <main className="shell" style={{ maxWidth: '22rem', paddingTop: '5rem' }}>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Vyra Inbox</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.9rem' }}>
        Sign in to continue.
      </p>

      <form action={formAction} className="card stack" style={{ marginTop: '1.5rem' }}>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {state.error !== null && <p className="notice">{state.error}</p>}
        <button className="button" type="submit" disabled={pending} style={{ width: '100%' }}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '1.25rem' }}>
        Accounts are created by an administrator. There is no self-serve sign-up.
      </p>
    </main>
  )
}
