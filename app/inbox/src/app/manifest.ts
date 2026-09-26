import type { MetadataRoute } from 'next'

/**
 * Enough to put the inbox on a phone's home screen, which is what lets it show
 * alerts at all on an iPhone: Safari only allows web push for a site added to
 * the home screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Vyra Inbox',
    short_name: 'Vyra',
    description: 'Shared sales inbox for WhatsApp rental enquiries',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#b4520f',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
