import { Card } from '@fixture/ui'
import { formatTitle } from '@app/lib/format'

export default function Home() {
  return <Card>{formatTitle('monorepo home')}</Card>
}
