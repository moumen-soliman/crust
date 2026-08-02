import type { ReactNode } from 'react'
export function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>
}
