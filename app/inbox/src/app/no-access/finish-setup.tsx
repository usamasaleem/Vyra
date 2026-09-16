'use client'

import { useActionState } from 'react'
import { OPERATOR_TIMEZONES } from '@vyra/contracts'
import { finishSetup, type FinishState } from './actions'

/**
 * Either "join them" or "set your own up", never both.
 *
 * Which one is decided on the server from the verified address; this only
 * renders what that decision produced. Showing both would invite somebody to
 * create a second company when a colleague is already waiting for them in one.
 */
export function FinishSetup({
  invitation,
}: {
  invitation: { operatorName: string; role: string } | null
}) {
  const [state, action, pending] = useActionState<FinishState, FormData>(
    finishSetup, { error: null },
  )

  return (
    <form action={action} className="stack">
      {invitation === null && (
        <>
          <div>
            <label className="label" htmlFor="company">Company name</label>
            <input className="input" id="company" name="company" placeholder="Dubai Exotic Rentals" required />
          </div>
          <div>
            <label className="label" htmlFor="timezone">Timezone</label>
            <select className="input" id="timezone" name="timezone" defaultValue="Asia/Dubai">
              {OPERATOR_TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </div>
        </>
      )}

      {state.error !== null && <p className="notice">{state.error}</p>}

      <button className="button" type="submit" disabled={pending}>
        {pending
          ? 'Setting up…'
          : invitation === null ? 'Create my company' : `Join ${invitation.operatorName}`}
      </button>
    </form>
  )
}
