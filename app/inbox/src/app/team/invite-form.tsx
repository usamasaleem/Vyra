'use client'

import { useActionState } from 'react'
import { MEMBERSHIP_ROLES } from '@vyra/contracts'
import { invite } from './actions'

export function InviteForm() {
  const [state, action, pending] = useActionState(invite, { error: null })

  return (
    <form action={action} className="card stack" style={{ marginBottom: '1.2rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
        <div style={{ flex: '1 1 16rem' }}>
          <label className="label" htmlFor="email">Invite a colleague</label>
          <input className="input" id="email" name="email" type="email" placeholder="sara@yourcompany.com" required />
        </div>
        <div>
          <label className="label" htmlFor="role">As</label>
          <select className="input" id="role" name="role" defaultValue="salesperson" style={{ width: 'auto' }}>
            {MEMBERSHIP_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Inviting…' : 'Invite'}
        </button>
      </div>
      {state.error !== null && <p className="notice" style={{ margin: 0 }}>{state.error}</p>}
    </form>
  )
}
