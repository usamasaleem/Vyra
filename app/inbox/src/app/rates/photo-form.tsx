'use client'

import { useActionState } from 'react'
import { hostsOf } from '@vyra/contracts'
import { savePhotos, type PhotoState } from '../actions'

/**
 * Photographs, as links.
 *
 * Links rather than uploads because every operator already has pictures of
 * their own cars on their own website, and pasting six URLs takes a minute
 * where building storage and an uploader takes a day. An upload screen can come
 * later and will write the same field.
 */
export function PhotoForm({ vehicleId, current }: { vehicleId: string; current: string[] }) {
  const [state, action, pending] = useActionState<PhotoState, FormData>(savePhotos, { error: null })
  const hosts = hostsOf(current)

  return (
    <form action={action} className="stack" style={{ gap: '0.5rem', marginTop: '0.9rem' }}>
      <input type="hidden" name="vehicleId" value={vehicleId} />

      <label className="label" htmlFor={`photos-${vehicleId}`}>
        Photo links, one per line — the first is the one a customer is sent
      </label>
      <textarea
        id={`photos-${vehicleId}`}
        className="input"
        name="photoUrls"
        rows={2}
        defaultValue={current.join('\n')}
        placeholder="https://your-site.com/photos/huracan-1.jpg"
      />

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="button secondary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save photos'}
        </button>
        {current.length > 0 && (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {current.length} saved
            {hosts.length > 0 && <> · served from {hosts.join(', ')}</>}
          </span>
        )}
        {state.error !== null && <span className="notice">{state.error}</span>}
      </div>
    </form>
  )
}
