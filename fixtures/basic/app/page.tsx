import { Hero } from '@/components'

export default function Home() {
  return (
    <main>
      <Hero title="crust fixture" />
      <p>Static home page.</p>
      {/* Deliberately bad: raw <img>, lazy-loaded, no dimensions, and far larger
          than its slot. Kept in the fixture so the image audit is exercised by
          something real rather than assumed to work. */}
      <img src="/hero.svg" alt="hero" loading="lazy" style={{ width: 320 }} />
    </main>
  )
}
