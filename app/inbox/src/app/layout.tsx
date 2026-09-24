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
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
