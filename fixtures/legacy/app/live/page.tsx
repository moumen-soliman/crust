import { readTheme } from '@/lib/session'

// Opting out explicitly. Next 16 rejects this under `cacheComponents`, so the
// forced-dynamic shape can only be pinned on the legacy rule set.
export const dynamic = 'force-dynamic'

export default async function LivePage() {
  return (
    <main>
      <h1>Live</h1>
      <p>theme: {await readTheme()}</p>
    </main>
  )
}
