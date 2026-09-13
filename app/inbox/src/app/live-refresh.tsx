'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Keeps a page current without a websocket.
 *
 * Polls a fingerprint endpoint and refreshes only when something actually
 * moved. A quiet inbox therefore costs one small query every few seconds
 * rather than re-rendering a page against a database a long way away.
 *
 * Stops while the tab is hidden — a forgotten open tab should not poll all
 * night — and checks immediately on becoming visible again, so coming back to
 * the tab shows current state rather than whatever was there hours ago.
 */
export function LiveRefresh({ conversationId }: { conversationId?: string }) {
  const router = useRouter()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const url =
      conversationId === undefined
        ? '/api/inbox/pulse'
        : `/api/inbox/pulse?conversation=${encodeURIComponent(conversationId)}`

    let known: string | null = null
    let cancelled = false

    const check = async () => {
      if (document.hidden || cancelled) return
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return
        const { fingerprint } = (await response.json()) as { fingerprint: string }
        if (known !== null && fingerprint !== known) {
          setStale(true)
          router.refresh()
          // The refresh is asynchronous; clear the flag once it has had time
          // to land rather than leaving a permanent badge on screen.
          setTimeout(() => setStale(false), 1200)
        }
        known = fingerprint
      } catch {
        // A failed poll is not worth surfacing. The next one will tell us.
      }
    }

    void check()
    const timer = setInterval(check, 4000)
    const onVisibilityChange = () => {
      if (!document.hidden) void check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [conversationId, router])

  if (!stale) return null
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed', bottom: '1rem', right: '1rem',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '7px', padding: '0.4rem 0.7rem',
        fontSize: '0.8rem', color: 'var(--muted)',
      }}
    >
      Updating…
    </div>
  )
}
