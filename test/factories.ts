import { computeCoverage } from '../src/analyze/coverage.ts'
import { VERSION } from '../src/version.ts'
import type { RouteSnapshot, Snapshot } from '../src/store/snapshot.ts'

/**
 * Snapshot builders for tests that need a shape rather than a real build.
 *
 * Shared deliberately: five copies of these had drifted apart, so adding one
 * field to the schema meant editing five files and getting five slightly
 * different defaults. Tests that need different values pass overrides.
 */
export function route(overrides: Partial<RouteSnapshot> = {}): RouteSnapshot {
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
    causes: [],
    clientBoundaries: [],
    barrels: [],
    layouts: [],
    sharedChunks: [],
    config: {},
    shell: null,
    warnings: [],
    conservativeModules: 0,
    ...overrides,
  }
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const routes = overrides.routes ?? [route()]
  return {
    schemaVersion: 1,
    toolVersion: VERSION,
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
    modules: {},
    sharedCauses: [],
    config: { cacheComponents: false, experimental: {}, sourceMaps: true },
    warnings: [],
    ...overrides,
    routes,
    // Derived from the routes rather than accepted as a default, so a test that
    // builds an unclassified route sees the confidence drop it should.
    coverage: overrides.coverage ?? computeCoverage(routes),
  }
}
