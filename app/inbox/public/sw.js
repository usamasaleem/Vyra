/**
 * The one job this service worker has: show an alert the worker pushed, and
 * open the page it is about when somebody taps it.
 *
 * No caching and no offline mode. The inbox is live data, and a service worker
 * that served yesterday's copy of a conversation would be worse than none.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let alert = { title: 'Vyra', body: 'A customer is waiting on you.', url: '/', tag: undefined }
  try {
    alert = { ...alert, ...event.data.json() }
  } catch {}
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      // The same situation replaces its earlier alert rather than stacking.
      tag: alert.tag,
      renotify: alert.tag !== undefined,
      data: { url: alert.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of open) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(url)
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
