'use client'

import { useActionState } from 'react'
import { addCar, type AddCarState } from '../../actions'

/**
 * The car, its price and its photographs, in the order a person has them to
 * hand.
 *
 * The rate is on the same form rather than a second step on purpose. A car
 * saved without one is a car the agent names and then refuses to price, and
 * the operator who just added it reads that as the product not working.
 *
 * Deposit stays optional, like on the Rates page: an operator who takes none
 * should leave it blank rather than be pushed into inventing a figure.
 */
const CATEGORIES: Array<[string, string]> = [
  ['exotic', 'Exotic'],
  ['luxury', 'Luxury'],
  ['sports', 'Sports'],
  ['suv', 'SUV'],
  ['convertible', 'Convertible'],
  ['sedan', 'Sedan'],
]

export function AddCarForm() {
  const [state, action, pending] = useActionState<AddCarState, FormData>(addCar, { error: null })
  const typed = (name: string) => state.values?.[name] ?? ''

  const field = (
    name: string,
    label: string,
    opts: { required?: boolean; type?: string; step?: string; placeholder?: string; min?: number } = {},
  ) => (
    <label style={{ fontSize: '0.82rem', display: 'block' }}>
      {label}
      <input
        className="input"
        name={name}
        type={opts.type ?? 'text'}
        required={opts.required}
        step={opts.step}
        min={opts.min}
        placeholder={opts.placeholder}
        defaultValue={typed(name)}
        style={{ marginTop: '0.2rem' }}
      />
    </label>
  )

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.6rem' }

  return (
    <form key={JSON.stringify(state.values ?? {})} action={action} className="card stack" style={{ gap: '1rem' }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>The car</strong></legend>
        <div style={{ ...grid, marginTop: '0.5rem' }}>
          {field('make', 'Make', { required: true, placeholder: 'Lamborghini' })}
          {field('model', 'Model', { required: true, placeholder: 'Urus' })}
          {field('variant', 'Variant (optional)', { placeholder: 'Performante' })}
          {field('year', 'Year', { required: true, type: 'number', step: '1', min: 1900, placeholder: '2024' })}
          {field('colour', 'Colour', { required: true, placeholder: 'Nero' })}
          <label style={{ fontSize: '0.82rem', display: 'block' }}>
            Category
            <select className="input" name="category" required defaultValue={typed('category')} style={{ marginTop: '0.2rem' }}>
              <option value="" disabled>Choose…</option>
              {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {field('seats', 'Seats (optional)', { type: 'number', step: '1', min: 1 })}
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>Registration</strong></legend>
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0.4rem' }}>
          Never shown to customers. Used to stop the same car being added twice.
        </p>
        <div style={grid}>
          {field('plate', 'Plate', { required: true, placeholder: 'Dubai A 12345' })}
          {field('chassisNumber', 'Chassis number (VIN)', { required: true })}
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>Price</strong></legend>
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0.4rem' }}>
          In AED. Weekly and monthly rates, delivery and mileage can be added on the Rates page.
        </p>
        <div style={grid}>
          {field('dailyRate', 'Per day', { required: true, type: 'number', step: '0.01', min: 0 })}
          {field('deposit', 'Deposit (optional)', { type: 'number', step: '0.01', min: 0 })}
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>Photos (optional)</strong></legend>
        <label className="label" htmlFor="add-car-photos" style={{ marginTop: '0.4rem' }}>
          Photo links, one per line — the first is the one a customer is sent. Photos of this car,
          not the model.
        </label>
        <textarea
          id="add-car-photos"
          className="input"
          name="photoUrls"
          rows={3}
          defaultValue={typed('photoUrls')}
          placeholder="https://your-site.com/photos/urus-1.jpg"
        />
      </fieldset>

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save car'}
        </button>
        {state.error !== null && <span className="notice">{state.error}</span>}
      </div>
    </form>
  )
}
