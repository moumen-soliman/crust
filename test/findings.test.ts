import { describe, expect, it } from 'vitest'
import { findingsFor } from '../src/findings/findings.ts'
import type { RouteSnapshot, Snapshot } from '../src/store/snapshot.ts'

function route(overrides: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return {
    id: 'app/page.tsx',
    pattern: '/',
    filePath: 'app/page.tsx',
    renderingMode: 'STATIC',
    renderingModeReason: null,
    firstLoadBytes: 100_000,
    routeBytes: 10_000,
    sharedBytes: 90_000,
    unattributedBytes: 0,
    modules: {},
    dependencies: {},
    dynamicReasons: [],
    clientBoundaryRoots: [],
    shell: null,
    warnings: [],
    ...overrides,
  }
}

function snapshot(routes: RouteSnapshot[], warnings: string[] = []): Snapshot {
  return {
    schemaVersion: 1,
    toolVersion: '0.1.1',
    buildId: 'aaaaaaaaaaaaaaaa',
    createdAt: '2026-01-01T00:00:00.000Z',
    gitSha: null,
    committedAt: null,
    parentSha: null,
    branch: 'main',
    dirty: false,
    nextVersion: '16.2.12',
    nodeMajor: 22,
    bundler: 'webpack',
    sourceSignature: 'sig',
    routes,
    modules: {},
    warnings,
  }
}

describe('first-run findings', () => {
  it('finds nothing to report on a clean build', () => {
    expect(findingsFor(snapshot([route()]))).toEqual([])
  })

  it('ranks a fully dynamic route above a heavy one', () => {
    const found = findingsFor(
      snapshot([
        route({ id: 'app/big/page.tsx', pattern: '/big', firstLoadBytes: 800_000 }),
        route({
          id: 'app/feed/page.tsx',
          pattern: '/feed',
          renderingMode: 'DYNAMIC',
          dynamicReasons: ['cookies() at app/feed/page.tsx:4'],
        }),
      ]),
    )

    expect(found[0]).toMatchObject({ kind: 'dynamic', route: '/feed' })
    expect(found[1]).toMatchObject({ kind: 'size', route: '/big' })
  })

  it('ranks a smaller shell above a larger one', () => {
    const withRatio = (pattern: string, shellRatio: number): RouteSnapshot =>
      route({
        id: `app${pattern}/page.tsx`,
        pattern,
        renderingMode: 'PARTIALLY_STATIC',
        shell: {
          predictedStatic: [],
          predictedHoles: [{ component: 'Feed', boundary: 'x:1', reason: 'uncached fetch at lib/http.ts:3' }],
          actual: { htmlPath: 'x', bytes: 1, holes: 1, boundaryIds: ['B:0'], shellRatio },
          agreement: 1,
          unknown: [],
        },
      })

    const found = findingsFor(snapshot([withRatio('/mild', 0.8), withRatio('/severe', 0.15)]))
    expect(found.map((f) => f.route)).toEqual(['/severe', '/mild'])
  })

  it('gives an action that names the fix, not the problem again', () => {
    const found = findingsFor(
      snapshot([
        route({
          renderingMode: 'PARTIALLY_STATIC',
          shell: {
            predictedStatic: [],
            predictedHoles: [{ component: 'ProductGallery', boundary: 'app/page.tsx:12', reason: 'uncached fetch at lib/http.ts:3' }],
            actual: { htmlPath: 'x', bytes: 1, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.45 },
            agreement: 1,
            unknown: [],
          },
        }),
      ]),
    )

    expect(found[0]?.headline).toBe('only 45% of this route is in the static shell')
    expect(found[0]?.detail).toBe('uncached fetch at lib/http.ts:3 — in <ProductGallery>')
    expect(found[0]?.action).toContain('use cache')
  })

  it('reports missing source maps as a setup gap, below any real route problem', () => {
    const found = findingsFor(
      snapshot(
        [
          route({ unattributedBytes: 40_000 }),
          route({ id: 'app/feed/page.tsx', pattern: '/feed', renderingMode: 'DYNAMIC' }),
        ],
        ['/: chunk.js: no source map emitted'],
      ),
    )

    expect(found[0]?.kind).toBe('dynamic')
    const setup = found.find((f) => f.kind === 'setup')
    expect(setup?.action).toContain('productionBrowserSourceMaps')
    expect(setup?.detail).toBe('worst route `/`: 39 kB (40%) untraceable')
  })

  it('does not claim a build has no source maps because one small chunk lacks one', () => {
    // webpack ships its polyfill chunk without a map even when
    // `productionBrowserSourceMaps` is on. One warning is not evidence that the
    // project is misconfigured, and saying so is a confident false statement.
    const found = findingsFor(
      snapshot([route({ unattributedBytes: 2_000 })], ['/: polyfills.js: no source map emitted']),
    )
    expect(found.find((f) => f.kind === 'setup')).toBeUndefined()
  })

  it('does not report low coverage as a setup problem when maps are present', () => {
    // A real fixture attributes 45% of its bytes with maps fully enabled; the
    // rest maps into framework internals. Nothing is misconfigured.
    const found = findingsFor(snapshot([route({ firstLoadBytes: 600_000, unattributedBytes: 330_000 })]))
    expect(found.find((f) => f.kind === 'setup')).toBeUndefined()
    expect(found.find((f) => f.kind === 'size')?.action).toContain('framework or vendor internals')
  })

  it('never sums unattributed bytes across routes that share chunks', () => {
    // The same 40 kB shared chunk is unattributed on both routes. Adding them
    // reports 78 kB of untraceable bytes in a build that contains 40.
    const found = findingsFor(
      snapshot(
        [
          route({ unattributedBytes: 40_000 }),
          route({ id: 'app/b/page.tsx', pattern: '/b', unattributedBytes: 40_000 }),
        ],
        ['/: chunk.js: no source map emitted'],
      ),
    )

    const setup = found.find((f) => f.kind === 'setup')
    expect(setup?.detail).toContain('39 kB')
    expect(setup?.detail).not.toContain('78 kB')
  })

  it('never reports a route handler as a problem', () => {
    // No client bundle, no shell, nothing to be dynamic about.
    expect(findingsFor(snapshot([route({ pattern: '/api/hook', renderingMode: 'ROUTE_HANDLER' })]))).toEqual([])
  })

  it('says unknown rather than guessing why a route is not prerendered', () => {
    const found = findingsFor(
      snapshot([route({ renderingMode: 'unknown', renderingModeReason: 'not prerendered, and no dynamic API found in source' })]),
    )
    expect(found[0]?.kind).toBe('unknown')
    expect(found[0]?.action).toContain('rather than guessed')
  })
})
