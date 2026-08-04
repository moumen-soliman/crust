import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

const title = 'crust - the production-build diff for Next.js'
const description =
  'Compare Next.js App Router production builds, decide what can ship, and trace rendering, caching, shell, and client-cost regressions to source.'

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL('https://crust.moumen.dev'),
  alternates: { canonical: '/' },
  openGraph: {
    title: 'crust - the production-build diff that tells you what can ship',
    description:
      'Compare two Next.js builds, lead with the merge decision, and group every affected route by the component, import, package, or source line that caused it.',
    type: 'website',
    url: '/',
    siteName: 'crust',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description:
      'Compare Next.js production builds and trace rendering, caching, shell, and client-cost regressions to source.',
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
