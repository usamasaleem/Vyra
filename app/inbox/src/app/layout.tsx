import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Vyra Inbox',
  description: 'Shared sales inbox for WhatsApp rental enquiries',
  icons: { apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Vyra', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Tells the browser too, so form controls and scrollbars stay light on a
  // phone in dark mode rather than drawing dark widgets on a white page.
  colorScheme: 'light',
  themeColor: '#ffffff',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
