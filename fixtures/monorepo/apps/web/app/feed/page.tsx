import { Suspense } from 'react'
import { Card, Chart } from '@fixture/ui'
import { loadPoints } from '~/lib/points'

export default function Feed() {
  return (
    <main>
      <Card>Feed</Card>
      <Suspense fallback={<p id="chart-fallback">Loading chart…</p>}>
        <FeedChart />
      </Suspense>
    </main>
  )
}

async function FeedChart() {
  const points = await loadPoints()
  return <Chart points={points} />
}
