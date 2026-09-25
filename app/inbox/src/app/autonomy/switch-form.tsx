'use client'

import { useActionState } from 'react'
import { switchAutonomy, type AutonomyResult } from './actions'

export function SwitchForm({ on, ready, canEdit }: { on: boolean; ready: boolean; canEdit: boolean }) {
  const [result, action, pending] = useActionState<AutonomyResult, FormData>(switchAutonomy, null)
  if (!canEdit) return <p className="muted" style={{ margin: 0 }}>Only an administrator can switch this.</p>
  return (
    <form action={action} style={{ display: 'grid', gap: '0.5rem' }}>
      <input type="hidden" name="on" value={on ? 'false' : 'true'} />
      <div>
        <button className={on ? 'button secondary' : 'button'} type="submit" disabled={pending || (!on && !ready)}>
          {on ? 'Turn autonomous off' : 'Turn autonomous on'}
        </button>
      </div>
      {!on && !ready && (
        <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>Finish the required items below first.</p>
      )}
      {result !== null && (
        <p className="notice" style={{ margin: 0 }}>Still missing: {result.missing.join('; ')}.</p>
      )}
    </form>
  )
}
