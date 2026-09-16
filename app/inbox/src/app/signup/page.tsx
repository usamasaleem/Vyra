'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { OPERATOR_TIMEZONES } from '@vyra/contracts'
import { signUp } from './actions'

/**
 * One form for two situations, because the person filling it in does not know
 * which one they are in.
 *
 * Somebody a colleague invited types their email and a password and joins that
 * company. Somebody who found this on their own also names their company and
 * gets one of their own. The company field is optional here and checked on the
 * server, so an invited person is never asked to name a company they are about
 * to join.
 */
export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, { error: null })

  return (
    <main className="shell" style={{ maxWidth: '24rem', paddingTop: '4rem' }}>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Set up Vyra</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.9rem' }}>
        Create your account. If a colleague invited you, use the address they invited.
      </p>

      <form action={formAction} className="card stack" style={{ marginTop: '1.5rem' }}>
        <div>
          <label className="label" htmlFor="email">Your email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            className="input" id="password" name="password" type="password"
            autoComplete="new-password" minLength={10} required
          />
          <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
            At least 10 characters. This account can read every customer conversation.
          </p>
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--line, #e5e5e5)', margin: '0.25rem 0' }} />

        <div>
          <label className="label" htmlFor="company">Company name</label>
          <input className="input" id="company" name="company" placeholder="Dubai Exotic Rentals" />
          <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
            Leave blank if you were invited to an existing company.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="timezone">Timezone</label>
          <select className="input" id="timezone" name="timezone" defaultValue="Asia/Dubai">
            {OPERATOR_TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
          <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
            Every date a customer mentions is resolved against this.
          </p>
        </div>

        {state.error !== null && <p className="notice">{state.error}</p>}
        <button className="button" type="submit" disabled={pending} style={{ width: '100%' }}>
          {pending ? 'Setting up…' : 'Create account'}
        </button>
      </form>

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '1.25rem' }}>
        Already have an account? <Link href="/login">Sign in</Link>.
      </p>
    </main>
  )
}
