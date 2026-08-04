import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareConfig } from '../src/analyze/config.ts'
import { diffSnapshots } from '../src/diff/diff.ts'
import { renderDiffTerminal } from '../src/terminal-ui/views.tsx'
import { SnapshotStore } from '../src/store/store.ts'
import { normalizeSnapshot } from '../src/store/normalize.ts'
import { SCHEMA_VERSION, type Snapshot } from '../src/store/snapshot.ts'
import { route, snapshot } from './factories.ts'

/**
 * A snapshot exactly as crust v3 wrote it: no `config`, no `sharedCauses`, no
 * `coverage`, and boundaries recorded as bare file paths. Written out in full
 * rather than derived from the current factory, because the whole point is that
 * it does not match the current shape - a factory-built stand-in would silently
 * acquire every new field the day one is added.
 */
const V3_ON_DISK = {
  schemaVersion: 3,
  // Frozen on purpose: this is what an older crust actually wrote, so it must
  // not track the current version the way the factory does.
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
  modules: {},
  warnings: [],
  routes: [
    {
      id: 'app/page.tsx',
      pattern: '/',
      filePath: 'app/page.tsx',
      renderingMode: 'STATIC',
      renderingModeReason: null,
      firstLoadBytes: 100_000,
      routeBytes: 10_000,
      sharedBytes: 90_000,
      unattributedBytes: 4_000,
      modules: { 'components/Hero.tsx': 6_000 },
      dependencies: { next: 90_000 },
      dynamicReasons: [],
      clientBoundaryRoots: ['components/Counter.tsx'],
      shell: null,
      warnings: [],
    },
  ],
} as unknown as Snapshot

/**
 * A snapshot exactly as crust v4 wrote it: it *has* a `config`, so it is not
 * caught by the "recorded no config at all" path above, but that config predates
 * `partialPrefetching` and `instantValidation`. Written out in full for the same
 * reason as `V3_ON_DISK` - derived from the factory it would quietly gain both
 * fields and stop testing anything.
 */
const V4_ON_DISK = {
  schemaVersion: 4,
  toolVersion: '0.2.1',
  buildId: 'bbbbbbbbbbbbbbbb',
  createdAt: '2026-02-01T00:00:00.000Z',
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
  routes: [
    {
      id: 'app/page.tsx',
      pattern: '/',
      filePath: 'app/page.tsx',
      renderingMode: 'STATIC',
      renderingModeReason: null,
      firstLoadBytes: 100_000,
      routeBytes: 10_000,
      sharedBytes: 90_000,
      unattributedBytes: 4_000,
      modules: {},
      dependencies: {},
      dynamicReasons: [],
      causes: [],
      clientBoundaries: [],
      barrels: [],
      layouts: [],
      sharedChunks: [],
      // The trap this fixture exists for: an instant route recorded before crust
      // read the key looks identical to one that never declared it.
      config: {},
      shell: null,
      warnings: [],
      conservativeModules: 0,
    },
  ],
} as unknown as Snapshot

describe('adding a route config key to an existing history', () => {
  it('refuses the pair outright rather than reporting `unset -> true` on every instant route', () => {
    // `route.config` is an open map, so a v4 baseline that never read `instant`
    // would diff as though someone had just added it to every route in the app -
    // a fabricated change, in the voice reserved for real ones. The schema guard
    // makes that impossible instead of merely unlikely.
    const head = snapshot({ schemaVersion: SCHEMA_VERSION, routes: [route({ config: { instant: true } })] })
    const diff = diffSnapshots(normalizeSnapshot(V4_ON_DISK), head)

    expect(diff.incomparable.join(' ')).toContain(`snapshot schema changed: v4 -> v${SCHEMA_VERSION}`)
    expect(SCHEMA_VERSION).toBeGreaterThan(4)
  })

  it('invents no build-level Instant Navigations change against a v4 config', () => {
    // The v4 record has a config, so it survives the `!before || !after` guard.
    // Only the per-field `undefined` checks stop `false -> false` being announced
    // as a flag flip nobody performed.
    const changes = compareConfig(normalizeSnapshot(V4_ON_DISK), snapshot())

    expect(changes.map((change) => change.key)).not.toContain('partialPrefetching')
    expect(changes.map((change) => change.key)).not.toContain('experimental.instantInsights.validationLevel')
  })

  it('leaves the unrecorded fields absent rather than defaulting them to opted-out', () => {
    const config = normalizeSnapshot(V4_ON_DISK).config

    expect(config).not.toBeNull()
    expect(config?.partialPrefetching).toBeUndefined()
    expect(config?.instantValidation).toBeUndefined()
  })
})

describe('reading a snapshot written by an older crust', () => {
  it('fills in every field added since, without inventing evidence', () => {
    const [route] = normalizeSnapshot(V3_ON_DISK).routes

    expect(route?.causes).toEqual([])
    expect(route?.barrels).toEqual([])
    expect(route?.layouts).toEqual([])
    expect(route?.sharedChunks).toEqual([])
    expect(route?.config).toEqual({})
    expect(route?.conservativeModules).toBe(0)
  })

  it('carries forward boundary files it knew, at a cost it did not', () => {
    const [route] = normalizeSnapshot(V3_ON_DISK).routes
    expect(route?.clientBoundaries).toEqual([{ file: 'components/Counter.tsx', component: null, bytes: 0 }])
  })

  it('derives coverage rather than reporting a real build at zero confidence', () => {
    // 96 kB attributed of 100 kB total, one route classified, no shell emitted.
    const coverage = normalizeSnapshot(V3_ON_DISK).coverage
    expect(coverage.routesClassified).toBe(1)
    expect(coverage.clientBytesAttributed).toBe(96_000)
    expect(coverage.confidence).toBeCloseTo((1 + 0.96) / 2, 2)
  })

  it('leaves the schema version alone so the diff can still refuse', () => {
    expect(normalizeSnapshot(V3_ON_DISK).schemaVersion).toBe(3)
  })

  it('records unrecorded configuration as unknown rather than as false', () => {
    // Defaulting it made the diff announce "browser source maps turned on" and
    // four experimental flag changes against a baseline that simply predated
    // the field. A build with no recorded config is not a build with none.
    expect(normalizeSnapshot(V3_ON_DISK).config).toBeNull()
  })

  it('invents no configuration change when the baseline recorded none', () => {
    const changes = compareConfig(normalizeSnapshot(V3_ON_DISK), snapshot())
    expect(changes.filter((change) => change.key.startsWith('experimental'))).toEqual([])
    expect(changes.map((change) => change.key)).not.toContain('productionBrowserSourceMaps')
    expect(changes.map((change) => change.key)).not.toContain('cacheComponents')
  })

  it('still reports what every version has always recorded', () => {
    // Bundler, Next and Node live on the snapshot root, so they are comparable
    // across any pair - withholding those too would be over-correcting.
    const changes = compareConfig(normalizeSnapshot(V3_ON_DISK), snapshot({ bundler: 'turbopack' }))
    expect(changes.map((change) => change.key)).toContain('bundler')
  })

  it('diffs against a current snapshot without throwing', () => {
    // The reported crash: `crust diff master` read a v3 baseline and dereferenced
    // `base.config.cacheComponents` before the schema guard ever ran.
    const head = snapshot({ schemaVersion: SCHEMA_VERSION })
    const diff = diffSnapshots(normalizeSnapshot(V3_ON_DISK), head)

    expect(diff.incomparable.join(' ')).toContain(`snapshot schema changed: v3 -> v${SCHEMA_VERSION}`)
    expect(diff.incomparable.join(' ')).toContain('crust analyze')
  })

  it('withholds deltas it has just said it cannot attribute', () => {
    // The v1 baseline had no shell data, so every route rendered as `—→0%`: a
    // shell that never existed, reported as one that collapsed. Numbers under an
    // "incomparable" banner are worse than no numbers.
    const output = renderDiffTerminal(diffSnapshots(normalizeSnapshot(V3_ON_DISK), snapshot({ schemaVersion: SCHEMA_VERSION })), 96)

    expect(output).toContain('CANNOT COMPARE THESE BUILDS')
    expect(output).toContain('Deltas withheld')
    expect(output).not.toContain('SIZE MOVEMENT')
    expect(output).not.toContain('regressions')
  })

  it('normalises on the way out of the store, not at each use site', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crust-store-'))
    const store = new SnapshotStore(root)
    await store.write(V3_ON_DISK)

    const read = await store.read(V3_ON_DISK.buildId)
    expect(read?.config).toBeNull()
    expect(read?.sharedCauses).toEqual([])
    expect(() => diffSnapshots(read!, snapshot())).not.toThrow()
  })
})
