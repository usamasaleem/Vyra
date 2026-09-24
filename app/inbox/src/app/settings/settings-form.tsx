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
  holdMinutes: number | null
  autoConfirmMaxDays: number | null
  handoverNoticeMinutes: number | null
  discountTiers: Array<{ minDays: number; percent: number }>
  addOns: Array<{ id: string; name: string; priceMinor: number; per: 'day' | 'rental' }>
  handoffSlaMinutes: number
  answerValidMinutes: number
  retentionDays: number
  fallbackOwnerMembershipId: string | null
  autoConfirmBookings: boolean
  autoConfirmLimitMinor: number | null
  availabilityCalendarComplete: boolean
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
  retention,
  settings, owners, readOnly,
}: {
  settings: Settings
  /**
   * What the retention number is actually doing, counted.
   *
   * "Shorter is kinder and harder to undo" is a sentence somebody should be
   * able to check before they find out whether it was true — and for a long
   * time it was not true at all, because nothing deleted anything.
   */
  retention: { expired: number; keptAsRecords: number }
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
          name="holdMinutes"
          label="Hold a car while they decide (minutes)"
          hint="Offered with every quote: book it now, or the agent holds it for them this long, and nobody else can book it in the meantime. It lets go on its own. Blank switches holds off."
          problem={problem('holdMinutes')}
        >
          {number('holdMinutes', settings.holdMinutes)}
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
          hint="Who hears about it when nobody accepts. Leave it blank and escalations go to your longest-standing admin, which is a guess at who you would have picked."
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
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Confirming bookings</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          Normally a customer says yes and one of your people confirms it. With this on, the
          agent confirms it itself when it can prove the car is free — the same overlap check,
          the same hold on the calendar, without the wait. Anything unusual still goes to a
          person: a car already held, a conversation somebody has taken over, an open handoff,
          or a total above the ceiling below.
        </p>
        {!settings.availabilityCalendarComplete && (
          <p className="notice">
            This does nothing until you tell us on <a href="/availability">Availability</a> that
            you keep the calendar current. Without that, &ldquo;no booking on file&rdquo; means
            nobody knows, and confirming on it is how the same car goes out twice.
          </p>
        )}
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.6rem 0' }}>
          <input
            type="checkbox"
            name="autoConfirmBookings"
            defaultChecked={settings.autoConfirmBookings}
            disabled={readOnly}
          />
          <span>Let the agent confirm bookings it can prove</span>
        </label>
        <Field
          name="autoConfirmLimit"
          label="Confirm on its own up to (AED total)"
          hint="Blank for no ceiling. Above this, the customer's yes still goes to one of your people."
          problem={problem('autoConfirmLimit')}
        >
          <input
            className="input" id="autoConfirmLimit" name="autoConfirmLimit"
            type="number" inputMode="numeric" min={1}
            defaultValue={settings.autoConfirmLimitMinor === null
              ? ''
              : String(settings.autoConfirmLimitMinor / 100)}
            disabled={readOnly}
          />
        </Field>
        <Field
          name="autoConfirmMaxDays"
          label="Confirm on its own up to (days)"
          hint="Longer rentals are quoted and held, and wait for one of your people. Blank for no limit."
          problem={problem('autoConfirmMaxDays')}
        >
          {number('autoConfirmMaxDays', settings.autoConfirmMaxDays)}
        </Field>
        <Field
          name="handoverNoticeMinutes"
          label="Notice needed for a same-day handover (minutes)"
          hint="A customer wanting the car sooner than this today is offered the earliest time that works instead. Blank for none."
          problem={problem('handoverNoticeMinutes')}
        >
          {number('handoverNoticeMinutes', settings.handoverNoticeMinutes)}
        </Field>
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>When the price is the objection</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          When a customer says it is too expensive, the agent may take this much off by itself —
          the best tier their rental reaches — or suggest a cheaper car free on the same dates.
          Anything more still goes to one of your people. Leave all rows blank to keep every
          discount with a person.
        </p>
        {problem('discountTiers') !== null && <p className="notice">{problem('discountTiers')}</p>}
        {[1, 2, 3].map((i) => {
          const tier = settings.discountTiers[i - 1]
          return (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.4rem 0', flexWrap: 'wrap' }}>
              <input
                className="input" name={`tierPercent${i}`} type="number" inputMode="numeric" min={1} max={50}
                defaultValue={tier?.percent ?? ''} disabled={readOnly} style={{ maxWidth: '6rem' }}
                aria-label={`Tier ${i} percent off`}
              />
              <span>% off rentals of</span>
              <input
                className="input" name={`tierDays${i}`} type="number" inputMode="numeric" min={1}
                defaultValue={tier?.minDays ?? ''} disabled={readOnly} style={{ maxWidth: '6rem' }}
                aria-label={`Tier ${i} minimum days`}
              />
              <span>days or more</span>
            </div>
          )
        })}
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Extras</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          Offered once, in a line, when a booking is confirmed, and added at these prices when the
          customer asks. Leave a name blank to remove that extra.
        </p>
        {problem('addOns') !== null && <p className="notice">{problem('addOns')}</p>}
        {[1, 2, 3, 4].map((i) => {
          const addOn = settings.addOns[i - 1]
          return (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.4rem 0', flexWrap: 'wrap' }}>
              <input
                className="input" name={`addOnName${i}`} placeholder="Name, e.g. Chauffeur"
                defaultValue={addOn?.name ?? ''} disabled={readOnly} style={{ maxWidth: '14rem' }}
                aria-label={`Extra ${i} name`}
              />
              <span>AED</span>
              <input
                className="input" name={`addOnPrice${i}`} type="number" inputMode="numeric" min={1}
                defaultValue={addOn === undefined ? '' : addOn.priceMinor / 100} disabled={readOnly}
                style={{ maxWidth: '7rem' }} aria-label={`Extra ${i} price`}
              />
              <select
                className="input" name={`addOnPer${i}`} defaultValue={addOn?.per ?? 'rental'}
                disabled={readOnly} style={{ width: 'auto' }} aria-label={`Extra ${i} charged`}
              >
                <option value="day">a day</option>
                <option value="rental">per rental</option>
              </select>
            </div>
          )
        })}
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
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.6rem' }}>
          {retention.expired === 0
            ? 'Nothing is past this yet. When something is, it is deleted on its own — the '
              + 'conversation, its messages, and the phone number once nothing else refers to it.'
            : `${retention.expired} conversation${retention.expired === 1 ? ' is' : 's are'} past `
              + 'this and will be deleted on the next sweep — messages, notes and the phone '
              + 'number with them.'}
          {retention.keptAsRecords > 0
            ? ` ${retention.keptAsRecords} older ${retention.keptAsRecords === 1 ? 'one is' : 'ones are'} `
              + 'kept regardless, because a quote or a booking is a record of a transaction '
              + 'rather than a conversation.'
            : ' A conversation that produced a quote or a booking is kept regardless: that is a '
              + 'record of a transaction rather than a conversation.'}
        </p>
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
