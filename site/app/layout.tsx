import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

const title = 'crust — catch Next.js regressions before they merge'
const description =
  'Production-build regression analysis for Next.js App Router. Explain route modes, static-shell composition, bundle attribution, and the source line behind a regression.'

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL('https://crust.moumen.dev'),
  alternates: { canonical: '/' },
  openGraph: {
    title: 'crust — know what became slower before it merges',
    description:
      'Compare production builds, catch silent static-shell regressions, and trace the cause to a component, import, and source line.',
    type: 'website',
    url: '/',
    siteName: 'crust',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description:
      'Route modes, shell composition, bundle attribution, and regression blame for Next.js App Router.',
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
