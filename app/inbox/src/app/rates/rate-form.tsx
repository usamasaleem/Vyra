'use client'

import { useActionState } from 'react'
import { saveRate } from '../actions'

/**
 * Entering a rate.
 *
 * Amounts are typed in whole currency because that is how a person thinks
 * about money, and converted to integer fils in the action — one boundary,
 * once, so nothing downstream ever handles a float.
 *
 * Only the daily rate is required. The rest are genuinely optional: an
 * operator with no weekly tier should leave it blank rather than be pushed
 * into inventing one, which is the same failure as an invented deposit with a
 * different shape.
 */
export function RateForm({
  vehicleId,
  current,
}: {
  vehicleId: string
  current: {
    currency: string
    dailyRateMinor: number | null
    weeklyRateMinor: number | null
    monthlyRateMinor: number | null
    minimumDays: number | null
    includedKmPerDay: number | null
    extraKmRateMinor: number | null
    depositMinor: number | null
    deliveryFeeMinor: number | null
  }
}) {
  const [state, action, pending] = useActionState(saveRate, { error: null })
  const major = (minor: number | null) => (minor === null ? '' : String(minor / 100))

  const field = (
    name: string,
    label: string,
    value: string | number,
    opts: { required?: boolean; step?: string } = {},
  ) => (
    <label style={{ fontSize: '0.82rem', display: 'block' }}>
      {label}
      <input
        className="input"
        name={name}
        type="number"
        min={0}
        step={opts.step ?? '0.01'}
        required={opts.required}
        defaultValue={value}
        style={{ marginTop: '0.2rem' }}
      />
    </label>
  )

  return (
    <form action={action} className="stack" style={{ gap: '0.6rem' }}>
      <input type="hidden" name="vehicleId" value={vehicleId} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))', gap: '0.6rem' }}>
        {field('dailyRate', `Per day (${current.currency})`, major(current.dailyRateMinor), { required: true })}
        {field('weeklyRate', 'Per week', major(current.weeklyRateMinor))}
        {field('monthlyRate', 'Per month', major(current.monthlyRateMinor))}
        {field('deposit', 'Deposit', major(current.depositMinor))}
        {field('deliveryFee', 'Delivery fee', major(current.deliveryFeeMinor))}
        {field('minimumDays', 'Minimum days', current.minimumDays ?? 1, { step: '1' })}
        {field('includedKm', 'Included km/day', current.includedKmPerDay ?? '', { step: '1' })}
        {field('extraKmRate', 'Extra km rate', major(current.extraKmRateMinor))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : current.dailyRateMinor === null ? 'Set rate' : 'Replace rate'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Saved against your name. The previous rate is kept, so old quotes stay explainable.
        </span>
        {state.error !== null && <span style={{ fontSize: '0.82rem' }}>{state.error}</span>}
      </div>
    </form>
  )
}
