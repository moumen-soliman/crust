import { describe, expect, it } from 'vitest'
import { computeCoverage, coverageLines } from '../src/analyze/coverage.ts'
import { route } from './factories.ts'
import type { ShellSnapshot } from '../src/store/snapshot.ts'

const shell = (overrides: Partial<ShellSnapshot> = {}): ShellSnapshot => ({
  predictedStatic: [],
  predictedHoles: [],
  actual: { htmlPath: 'server/app/index.html', bytes: 1024, holes: 0, boundaryIds: [], shellRatio: 1 },
  agreement: 1,
  unknown: [],
  ...overrides,
})

describe('coverage', () => {
  it('reports full confidence when everything was accounted for', () => {
    const coverage = computeCoverage([
      route({ shell: shell(), modules: { 'a.tsx': 1000 }, unattributedBytes: 0 }),
      route({ pattern: '/b', shell: shell(), dependencies: { next: 5000 }, unattributedBytes: 0 }),
    ])

    expect(coverage).toMatchObject({
      routesTotal: 2,
      routesClassified: 2,
      shellsEmitted: 2,
      shellsMeasured: 2,
      confidence: 1,
    })
  })

  it('drops confidence for a route it refused to classify', () => {
    const coverage = computeCoverage([
      route({ shell: shell() }),
      route({ pattern: '/b', renderingMode: 'unknown', shell: shell() }),
    ])

    expect(coverage.routesClassified).toBe(1)
    expect(coverage.confidence).toBeLessThan(1)
  })

  it('counts dependency bytes as attributed', () => {
    // React is not first-party and nobody can edit it, but it is traced. Calling
    // it a gap would report near-zero attribution on every real app.
    const coverage = computeCoverage([
      route({ modules: { 'a.tsx': 1000 }, dependencies: { next: 9000 }, unattributedBytes: 0 }),
    ])

    expect(coverage.clientBytesAttributed).toBe(10_000)
    expect(coverage.clientBytesTotal).toBe(10_000)
  })

  it('penalises bytes it could not trace to any source', () => {
    const coverage = computeCoverage([
      route({ shell: shell(), modules: { 'a.tsx': 2000 }, unattributedBytes: 2000 }),
    ])

    expect(coverage.clientBytesAttributed / coverage.clientBytesTotal).toBe(0.5)
    expect(coverage.confidence).toBeCloseTo((1 + 1 + 0.5) / 3, 2)
  })

  it('skips a dimension with nothing to measure rather than scoring it zero', () => {
    // No route emitted a shell. That is not a failed shell analysis; there was
    // no shell to analyse, and folding it in as a miss would report low
    // confidence in an answer that is completely solid.
    const coverage = computeCoverage([route({ shell: null, modules: { 'a.tsx': 1000 }, unattributedBytes: 0 })])

    expect(coverage.shellsEmitted).toBe(0)
    expect(coverage.confidence).toBe(1)
  })

  it('does not count route handlers as unclassified', () => {
    // A route handler has no client bundle, no shell and no rendering mode.
    // Nothing was missed, so an API-heavy app must not look unanalysable.
    const coverage = computeCoverage([
      route({ shell: shell() }),
      route({ pattern: '/api/x', renderingMode: 'ROUTE_HANDLER', shell: null }),
    ])

    expect(coverage.routesTotal).toBe(1)
    expect(coverage.confidence).toBe(1)
  })

  it('reports counts a reader can recompute the score from', () => {
    const lines = coverageLines(
      computeCoverage([
        route({ shell: shell({ unknown: ['Hero renders a component it receives'] }), modules: { 'a.tsx': 1 }, unattributedBytes: 1 }),
      ]),
    )

    expect(lines).toContain('1/1 routes classified')
    expect(lines).toContain('1/1 emitted shells measured')
    expect(lines).toContain('50% of client JavaScript attributed')
    expect(lines).toContain('1 unresolved component relationships')
  })

  it('returns zero rather than dividing by nothing on an empty build', () => {
    expect(computeCoverage([]).confidence).toBe(0)
  })
})
