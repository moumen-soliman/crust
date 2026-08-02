'use client'

export function Sparkline({ active }: { active: boolean }) {
  return <svg width="40" height="12" opacity={active ? 1 : 0.4} />
}
