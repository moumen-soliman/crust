import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'crust — route-level performance for Next.js App Router',
  description:
    'Bundle attribution, static shell composition and regression blame for Next.js App Router. Find out which import grew a route and which call site pushed a component out of the shell.',
  metadataBase: new URL('https://crust.moumen.dev'),
  openGraph: {
    title: 'crust',
    description: 'Route-level performance analysis for Next.js App Router.',
    type: 'website',
  },
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
