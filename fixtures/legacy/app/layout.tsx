import type { ReactNode } from 'react'

export const metadata = { title: 'crust legacy fixture' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
