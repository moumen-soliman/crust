import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

const title = 'crust - catch Next.js regressions before they merge'
const description =
  'Production-build regression analysis for Next.js App Router. Explain route modes, static-shell composition, bundle attribution, and complete source cause chains.'

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL('https://crust.moumen.dev'),
  alternates: { canonical: '/' },
  openGraph: {
    title: 'crust - know what became slower before it merges',
    description:
      'Compare production builds, trace regressions to a component, import, and source line, and see every route sharing the cause.',
    type: 'website',
    url: '/',
    siteName: 'crust',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description:
      'Route modes, shell composition, bundle attribution, complete cause chains, and regression blame for Next.js App Router.',
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
