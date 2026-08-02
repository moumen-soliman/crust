import { describe, expect, it } from 'vitest'
import { computeCoverage } from '../src/analyze/coverage.ts'
import { latestCompatibleBaseline } from '../src/diff/compatible.ts'
import { route } from './factories.ts'
import type { Snapshot } from '../src/store/snapshot.ts'

describe('automatic local baseline', () => {
  it('selects the newest compatible build for the same route set', () => {
    const head = snapshot('head')
    const wrongApp = snapshot('other', { routeId: 'other/page.tsx' })
    const wrongFramework = snapshot('next-17', { nextVersion: '17.0.0' })
    const previous = snapshot('previous')

    expect(latestCompatibleBaseline(head, [wrongApp, wrongFramework, previous])?.buildId).toBe('previous')
  })

  it('does not compare a build to a stored copy of itself', () => {
    const head = snapshot('same')
    expect(latestCompatibleBaseline(head, [head])).toBeNull()
  })
})

function snapshot(buildId: string, overrides: { routeId?: string; nextVersion?: string } = {}): Snapshot {
  return {
    schemaVersion: 1,
    toolVersion: 'test',
    buildId,
    createdAt: '2026-08-02T00:00:00.000Z',
    gitSha: null,
    committedAt: null,
    parentSha: null,
    branch: null,
    dirty: false,
    nextVersion: overrides.nextVersion ?? '16.2.0',
    nodeMajor: 22,
    bundler: 'turbopack',
    sourceSignature: buildId,
    routes: [route({ id: overrides.routeId ?? 'app/page.tsx', firstLoadBytes: 1, routeBytes: 1, sharedBytes: 0 })],
    modules: {},
    coverage: computeCoverage([]),
    sharedCauses: [],
    config: { cacheComponents: false, experimental: {}, sourceMaps: true },
    warnings: [],
  }
}
