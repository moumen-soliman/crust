import type { ReactNode } from 'react'
import { CrustDevtools } from '@/components/CrustDevtools'

export const metadata = { title: 'crust fixture' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CrustDevtools />
      </body>
    </html>
  )
}
