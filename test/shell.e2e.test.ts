import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeBuild } from '../src/analyze/analyze.ts'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'basic')

/**
 * These run against real build output, so they are skipped unless the fixture has
 * been built. CI builds it; locally, run:
 *
 *   CRUST_FIXTURE_MODE=cc pnpm --filter crust-fixture-basic exec next build --webpack
 */
const built = (dist: string) => existsSync(join(FIXTURE, dist, 'app-path-routes-manifest.json'))

describe.skipIf(!built('.next-cc'))('shell engine against a real Cache Components build', () => {
  it('predicts the hole and names the call site that caused it', async () => {
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-cc', toolVersion: 'test' })
    const dashboard = snapshot.routes.find((r) => r.pattern === '/dashboard')

    expect(dashboard?.renderingMode).toBe('PARTIALLY_STATIC')
    expect(dashboard?.shell?.predictedHoles).toEqual([
      expect.objectContaining({ component: 'Theme', reason: expect.stringContaining('cookies()') }),
    ])
  })

  it('agrees with the shell the build actually emitted', async () => {
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-cc', toolVersion: 'test' })
    const dashboard = snapshot.routes.find((r) => r.pattern === '/dashboard')

    // Layer 1 vs layer 2: one predicted hole, one pending boundary in the HTML.
    expect(dashboard?.shell?.actual?.holes).toBe(1)
    expect(dashboard?.shell?.actual?.boundaryIds).toEqual(['B:0'])
    expect(dashboard?.shell?.agreement).toBe(1)
  })

  it('measures the static home page as a complete shell', async () => {
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-cc', toolVersion: 'test' })
    const home = snapshot.routes.find((r) => r.pattern === '/')
    expect(home?.renderingMode).toBe('STATIC')
    expect(home?.shell?.actual?.shellRatio).toBe(1)
  })

  it('attributes client bytes to the barrel-imported components the route never renders', async () => {
    // `app/page.tsx` imports only `Hero` from `components/index.ts`, but the
    // barrel drags the client components in. This is the defect the tool exists
    // to surface, so it is pinned.
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-cc', toolVersion: 'test' })
    const home = snapshot.routes.find((r) => r.pattern === '/')
    const modules = Object.keys(home?.modules ?? {})

    expect(modules).toContain('fixtures/basic/components/Gallery.tsx')
    expect(modules).toContain('fixtures/basic/components/Counter.tsx')
  })
})

describe.skipIf(!built('.next-turbo'))('turbopack adapter', () => {
  it('produces the same route table as webpack does', async () => {
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-turbo', toolVersion: 'test' })
    expect(snapshot.bundler).toBe('turbopack')
    expect(snapshot.routes.map((r) => r.pattern).sort()).toEqual(['/', '/dashboard', '/products/[slug]'])
  })

  it('resolves first-party sources despite root-anchored source paths', async () => {
    const snapshot = await analyzeBuild({ cwd: FIXTURE, distDir: '.next-turbo', toolVersion: 'test' })
    const all = snapshot.routes.flatMap((r) => Object.keys(r.modules))
    expect(all.some((f) => f.endsWith('components/Gallery.tsx'))).toBe(true)
  })
})
