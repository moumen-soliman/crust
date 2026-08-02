import { staticGreeting } from '@/lib/session'

// ISR: prerendered with a revalidate window. The prerender manifest reports
// this the same way it reports a fully static route, so the seconds are the
// only thing that distinguishes them.
export const revalidate = 60

export default function IsrPage() {
  return (
    <main>
      <h1>ISR</h1>
      <p>{staticGreeting()}</p>
    </main>
  )
}
