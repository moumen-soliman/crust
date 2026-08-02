'use client'

import { useMemo, useState } from 'react'
import { Sparkline } from '@fixture/icons'

const PALETTE = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`)

export function Chart({ points }: { points: number[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const scaled = useMemo(() => points.map((p) => p * 100), [points])
  return (
    <div onMouseLeave={() => setHover(null)}>
      {scaled.map((p, i) => (
        <span key={i} style={{ color: PALETTE[i % PALETTE.length] }} onMouseEnter={() => setHover(i)}>
          {p}
        </span>
      ))}
      <Sparkline active={hover !== null} />
    </div>
  )
}
