'use client'

import { useEffect } from 'react'

/**
 * Gated on a build-time env var, so when it is unset the bundler eliminates the
 * dynamic import entirely and neither the widget nor the manifest reaches
 * production. A runtime `if` would still ship both.
 */
export function CrustDevtools() {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_CRUST) return
    let dispose: (() => void) | undefined
    import('crust/widget').then((m) => {
      dispose = m.mountCrustWidget()
    })
    return () => dispose?.()
  }, [])

  return null
}
