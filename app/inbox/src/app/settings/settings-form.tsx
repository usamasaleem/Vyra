'use client'

import { useActionState } from 'react'
import { OPERATOR_TIMEZONES } from '@vyra/contracts'
import { saveSettings, type SettingsState } from './actions'

type Settings = {
  name: string
  timezone: string
  websiteUrl: string | null
  aiResumesAfterMinutes: number | null
  followUpAfterMinutes: number
  handoffSlaMinutes: number
  answerValidMinutes: number
  retentionDays: number
  fallbackOwnerMembershipId: string | null
}

/**
 * Each field says what it costs to get wrong, because none of these are
 * obvious from their names and all of them are timers on messages to real
 * people. "Follow up after" is not a preference; it is how long somebody sits
 * looking at a conversation that has stopped.
 */
function Field({
  label, hint, name, children, problem,
}: {
  label: string
  hint: string
  name: string
  children: React.ReactNode
  problem?: string | undefined
}) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label className="label" htmlFor={name}>{label}</label>
      {children}
      <p className="muted" style={{ fontSize: '0.78rem', margin: '0.25rem 0 0' }}>{hint}</p>
      {problem !== undefined && (
        <p className="notice" style={{ margin: '0.3rem 0 0' }}>{problem}</p>
      )}
    </div>
  )
}

export function SettingsForm({
  settings, owners, readOnly,
}: {
  settings: Settings
  owners: Array<{ membershipId: string; label: string }>
  readOnly: boolean
}) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(
    saveSettings, { problems: [], saved: false },
  )

  const problem = (field: string) =>
    state.problems.find((p) => p.field === field)?.message

  const number = (name: string, value: number | null) => (
    <input
      className="input" id={name} name={name} type="number" inputMode="numeric"
      defaultValue={value ?? ''} disabled={readOnly} style={{ maxWidth: '10rem' }}
    />
  )

  return (
    <form action={action}>
      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>The company</h2>

        <Field name="name" label="Name" hint="What your team sees. Customers never see it." problem={problem('name')}>
          <input className="input" id="name" name="name" defaultValue={settings.name} disabled={readOnly} />
        </Field>

        <Field
          name="websiteUrl"
          label="Website (optional)"
          hint="Where your whole fleet can be seen. Offered only to a customer who asks to see everything rather than be asked questions — tapping it leaves WhatsApp for their browser, so it costs the conversation and is worth it only when they asked for it."
          problem={problem('websiteUrl')}
        >
          <input
            className="input" id="websiteUrl" name="websiteUrl" type="url"
            placeholder="https://your-site.com/fleet"
            defaultValue={settings.websiteUrl ?? ''} disabled={readOnly}
          />
        </Field>

        <Field
          name="timezone"
          label="Timezone"
          hint="Every date a customer mentions is resolved against this. Getting it wrong means a car delivered on the wrong day."
          problem={problem('timezone')}
        >
          <select className="input" id="timezone" name="timezone" defaultValue={settings.timezone} disabled={readOnly}>
            {OPERATOR_TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </Field>
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Chasing a quiet customer</h2>

        <Field
          name="followUpAfterMinutes"
          label="Follow up after (minutes)"
          hint="Somebody who asks about a car and goes quiet for ten minutes is still holding their phone. Four hours later they are not. Two more chases follow at six and twelve times this gap, and all of them stop at the 24-hour window."
          problem={problem('followUpAfterMinutes')}
        >
          {number('followUpAfterMinutes', settings.followUpAfterMinutes)}
        </Field>

        <Field
          name="aiResumesAfterMinutes"
          label="Agent takes a conversation back after (minutes)"
          hint="When a salesperson takes over and then stops replying. Blank switches it off entirely, and a customer then waits for a person however long that takes. The agent gets the ability to reply back, not the authority to decide — whatever needed a person still does."
          problem={problem('aiResumesAfterMinutes')}
        >
          {number('aiResumesAfterMinutes', settings.aiResumesAfterMinutes)}
        </Field>
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Handing over to a person</h2>

        <Field
          name="handoffSlaMinutes"
          label="Escalate an unanswered handoff after (minutes)"
          hint="How long a customer may wait on a person before this is somebody else's problem."
          problem={problem('handoffSlaMinutes')}
        >
          {number('handoffSlaMinutes', settings.handoffSlaMinutes)}
        </Field>

        <Field
          name="fallbackOwnerMembershipId"
          label="Who to escalate to"
          hint="Who hears about it when nobody accepts. With nobody named, the escalation is written to a log and reaches no one — which is the state this operator has been in."
        >
          <select
            className="input" id="fallbackOwnerMembershipId" name="fallbackOwnerMembershipId"
            defaultValue={settings.fallbackOwnerMembershipId ?? ''} disabled={readOnly}
          >
            <option value="">Nobody</option>
            {owners.map((o) => (
              <option key={o.membershipId} value={o.membershipId}>{o.label}</option>
            ))}
          </select>
        </Field>

        <Field
          name="answerValidMinutes"
          label="An operations answer stays usable for (minutes)"
          hint="Availability at 9am says nothing about 4pm. Past this the agent rechecks rather than repeating what it was told."
          problem={problem('answerValidMinutes')}
        >
          {number('answerValidMinutes', settings.answerValidMinutes)}
        </Field>
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Keeping records</h2>
        <Field
          name="retentionDays"
          label="Keep conversations for (days)"
          hint="Conversations, contacts and anything a customer sent. Shorter is kinder and harder to undo."
          problem={problem('retentionDays')}
        >
          {number('retentionDays', settings.retentionDays)}
        </Field>
      </section>

      {!readOnly && (
        <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center' }}>
          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save settings'}
          </button>
          {state.saved && <span className="muted" style={{ fontSize: '0.85rem' }}>Saved.</span>}
        </div>
      )}
    </form>
  )
}
