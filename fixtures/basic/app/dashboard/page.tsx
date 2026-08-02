import { Suspense } from 'react'
import { cookies } from 'next/headers'

// Under Cache Components the uncached read has to sit under a boundary, so the
// static part of this route stays in the shell and only <Theme> is postponed.
export default function Dashboard() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Suspense fallback={<p id="theme-fallback">Loading theme…</p>}>
        <Theme />
      </Suspense>
    </main>
  )
}

async function Theme() {
  const store = await cookies()
  return <p>theme: {store.get('theme')?.value ?? 'light'}</p>
}
