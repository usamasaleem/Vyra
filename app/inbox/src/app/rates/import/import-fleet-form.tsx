'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import {
  confirmFleetImport,
  previewFleetImport,
  type FleetImportState,
} from '../../actions'

/** What is wrong with a row, in the operator's words. */
const WHY: Record<string, string> = {
  make: 'Make missing',
  model: 'Model missing',
  year: 'Year is not a four-digit year',
  colour: 'Colour missing',
  category: 'Category not recognised (use exotic, luxury, SUV, sports, convertible or sedan)',
  plate: 'Plate missing',
  chassis: 'Chassis number missing',
  seats: 'Seats is not a whole number',
  rate: 'Daily rate missing or not an amount',
  deposit: 'Deposit is not an amount',
  plate_taken: 'Already in your fleet (same plate)',
  chassis_taken: 'Already in your fleet (same chassis)',
  repeated_in_sheet: 'Listed twice in the sheet',
}

const FIELD_NAMES: Record<string, string> = {
  make: 'Make', model: 'Model', variant: 'Variant', year: 'Year', colour: 'Colour', category: 'Category',
  plate: 'Plate', chassis: 'Chassis number', seats: 'Seats', dailyRate: 'Daily rate', deposit: 'Deposit',
}

const aed = (minor: number) => (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })

export function ImportFleetForm() {
  const [previewed, previewAction, previewing] = useActionState<FleetImportState, FormData>(
    previewFleetImport, { error: null },
  )
  const [confirmed, confirmAction, saving] = useActionState<FleetImportState, FormData>(
    confirmFleetImport, { error: null },
  )

  if (confirmed.saved) {
    const { added, skipped } = confirmed.saved
    return (
      <div className="card stack">
        <p>
          <strong>{added} car{added === 1 ? '' : 's'} added.</strong> The agent can offer and quote
          {added === 1 ? ' it' : ' them'} now.
        </p>
        {skipped.length > 0 && (
          <div>
            <p className="muted" style={{ margin: 0 }}>Not imported:</p>
            <ul>
              {skipped.map((s) => <li key={s.line}>Row {s.line}, {s.label}: {s.why}</li>)}
            </ul>
          </div>
        )}
        <p><Link className="button" href="/rates">See them on Rates</Link></p>
      </div>
    )
  }

  const preview = previewed.preview
  const ready = preview?.rows.filter((r) => r.problem === null) ?? []
  const blocked = preview?.rows.filter((r) => r.problem !== null) ?? []

  return (
    <div className="stack" style={{ gap: '1rem' }}>
      <form action={previewAction} className="card stack">
        <label className="label" htmlFor="fleet-sheet">Your spreadsheet (.xlsx or .csv)</label>
        <input id="fleet-sheet" className="input" name="sheet" type="file" accept=".xlsx,.csv,text/csv" required />
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="button" type="submit" disabled={previewing}>
            {previewing ? 'Reading…' : 'Read the file'}
          </button>
          {previewed.error !== null && <span className="notice">{previewed.error}</span>}
        </div>
      </form>

      {preview && (
        <form action={confirmAction} className="card stack">
          <p style={{ margin: 0 }}>
            <strong>Columns found:</strong>{' '}
            {Object.entries(preview.matched).map(([field, heading]) => `${FIELD_NAMES[field] ?? field} ← “${heading}”`).join(', ')}
          </p>
          {preview.missing.length > 0 && (
            <p className="notice" style={{ margin: 0 }}>
              No column found for {preview.missing.map((f) => FIELD_NAMES[f] ?? f).join(', ')}. Cars
              cannot be saved without {preview.missing.length === 1 ? 'it' : 'them'}; add
              {preview.missing.length === 1 ? ' it' : ' them'} to the sheet and read it again.
            </p>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Row</th><th>Car</th><th>Year</th><th>Colour</th><th>Category</th>
                  <th>Plate</th><th>Per day (AED)</th><th>Deposit</th><th></th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} style={{ opacity: r.problem === null ? 1 : 0.7 }}>
                    <td>{r.line}</td>
                    <td>{[r.car.make, r.car.model, r.car.variant].filter(Boolean).join(' ')}</td>
                    <td>{Number.isNaN(r.car.year) ? '' : r.car.year}</td>
                    <td>{r.car.colour}</td>
                    <td>{r.car.category}</td>
                    <td>{r.car.plate}</td>
                    <td>{r.car.dailyRateMinor > 0 ? aed(r.car.dailyRateMinor) : ''}</td>
                    <td>{r.car.depositMinor !== null && !Number.isNaN(r.car.depositMinor) ? aed(r.car.depositMinor) : ''}</td>
                    <td>{r.problem === null ? 'Ready' : <span className="notice">{WHY[r.problem]}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <input type="hidden" name="cars" value={JSON.stringify(ready)} />
          {blocked.length > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              {blocked.length} row{blocked.length === 1 ? '' : 's'} will be left out. Fix the sheet
              and read it again to include {blocked.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="button" type="submit" disabled={saving || ready.length === 0}>
              {saving ? 'Importing…' : `Import ${ready.length} car${ready.length === 1 ? '' : 's'}`}
            </button>
            {confirmed.error !== null && <span className="notice">{confirmed.error}</span>}
          </div>
        </form>
      )}
    </div>
  )
}
