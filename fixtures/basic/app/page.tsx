import { Hero } from '@/components'

// Fully static route: no dynamic APIs, no uncached fetch.
export default function Home() {
  return (
    <main>
      <Hero title="crust fixture" />
      <p>Static home page.</p>
    </main>
  )
}
