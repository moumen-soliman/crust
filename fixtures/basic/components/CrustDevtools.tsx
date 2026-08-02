'use client'

import { useEffect } from 'react'

/**
 * Gated on a build-time env var, so when it is unset the bundler eliminates both
 * dynamic imports and neither the widget nor the collector reaches production.
 * A runtime `if` would still ship the code.
 */
export function CrustDevtools() {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_CRUST) return

    const disposers: (() => void)[] = []
    void import('@moumen/crust/collector').then((m) => disposers.push(m.startCollector()))
    void import('@moumen/crust/widget').then((m) => disposers.push(m.mountCrustWidget()))

    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [])

  return null
}
