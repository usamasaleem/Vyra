'use client'

import { useEffect, useState } from 'react'
import { removeAlertDevice, saveAlertDevice, sendTestAlert } from './actions'

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

type State =
  | 'checking'
  | 'unsupported'
  | 'install-first'
  | 'blocked'
  | 'off'
  | 'on'

/**
 * Turning alerts on for the device in somebody's hand.
 *
 * An iPhone only allows it once the inbox is on the home screen, which is the
 * most common reason it "does not work" — so that case says what to do rather
 * than showing a button that fails.
 */
export function AlertsSwitch({ publicKey }: { publicKey: string | null }) {
  const [state, setState] = useState<State>('checking')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
      const installed = window.matchMedia('(display-mode: standalone)').matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setState(ios && !installed ? 'install-first' : 'unsupported')
        return
      }
      if (Notification.permission === 'denied') { setState('blocked'); return }
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      const existing = await registration.pushManager.getSubscription()
      setState(existing !== null ? 'on' : 'off')
    })().catch(() => setState('unsupported'))
  }, [])

  async function turnOn() {
    if (publicKey === null) return
    setBusy(true)
    setNote(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return }
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      })
      const json = subscription.toJSON()
      await saveAlertDevice({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.['p256dh'] ?? '',
        auth: json.keys?.['auth'] ?? '',
        userAgent: navigator.userAgent,
      })
      setState('on')
      await sendTestAlert()
      setNote('Done. A test alert is on its way — it should arrive within half a minute.')
    } catch {
      setNote('That did not work. Try again, and if it keeps failing, reload the page first.')
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setBusy(true)
    setNote(null)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription !== null) {
        await removeAlertDevice(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setState('off')
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    try {
      await sendTestAlert()
      setNote('Sent. It should arrive within half a minute.')
    } finally {
      setBusy(false)
    }
  }

  if (publicKey === null) {
    return <p className="card">Alerts are still being set up. Try again in a minute.</p>
  }

  return (
    <div className="card" style={{ display: 'grid', gap: '0.75rem' }}>
      {state === 'checking' && <p className="muted" style={{ margin: 0 }}>Checking this device…</p>}

      {state === 'install-first' && (
        <p style={{ margin: 0 }}>
          On an iPhone, alerts only work once the inbox is on your home screen. Tap the Share button,
          then <strong>Add to Home Screen</strong>, open Vyra from there, sign in, and come back to this page.
        </p>
      )}

      {state === 'unsupported' && (
        <p style={{ margin: 0 }}>This browser cannot show alerts. Chrome on Android, Safari on a Mac, or the
          inbox added to an iPhone&rsquo;s home screen can.</p>
      )}

      {state === 'blocked' && (
        <p style={{ margin: 0 }}>Alerts are blocked for this site in the browser&rsquo;s settings. Allow
          notifications for it there, then reload this page.</p>
      )}

      {state === 'off' && (
        <>
          <p style={{ margin: 0 }}>Alerts are <strong>off</strong> on this device.</p>
          <div><button className="button" onClick={turnOn} disabled={busy}>Turn on alerts on this device</button></div>
        </>
      )}

      {state === 'on' && (
        <>
          <p style={{ margin: 0 }}>Alerts are <strong>on</strong> on this device.</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="button" onClick={test} disabled={busy}>Send me a test alert</button>
            <button className="button secondary" onClick={turnOff} disabled={busy}>Turn off on this device</button>
          </div>
        </>
      )}

      {note !== null && <p className="muted" style={{ margin: 0 }}>{note}</p>}
    </div>
  )
}
