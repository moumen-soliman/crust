import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeCoverage } from '../src/analyze/coverage.ts'
import { latestCompatibleBaseline } from '../src/diff/compatible.ts'
import { SnapshotStore } from '../src/store/store.ts'
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

describe('isSelfBaseline', () => {
  it('recognises the head build id so diff can explain why resolve returned null', () => {
    const store = new SnapshotStore('/tmp')
    const head = snapshot('same')

    expect(store.isSelfBaseline('same', head, [head])).toBe(true)
    expect(store.isSelfBaseline('other', head, [head])).toBe(false)
  })

  it('treats the head git SHA as self only when no sibling snapshot exists at that commit', () => {
    const store = new SnapshotStore('/tmp')
    const sha = 'a'.repeat(40)
    const head = { ...snapshot('head'), gitSha: sha }
    const sibling = { ...snapshot('sibling'), gitSha: sha }

    expect(store.isSelfBaseline(sha, head, [head])).toBe(true)
    expect(store.isSelfBaseline(sha.slice(0, 8), head, [head])).toBe(true)
    expect(store.isSelfBaseline(sha, head, [head, sibling])).toBe(false)
  })
})

describe('resolving a ref that has more than one snapshot', () => {
  it('prefers a comparable record over one the diff would refuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crust-resolve-'))
    const store = new SnapshotStore(root)
    const sha = 'a'.repeat(40)

    // Both were recorded on the same commit - the older one under a schema this
    // build no longer compares against. Written oldest-last so list() order alone
    // cannot be what makes this pass.
    const stale = { ...snapshot('stale'), gitSha: sha, schemaVersion: 1, createdAt: '2026-08-02T09:00:00.000Z' }
    const usable = { ...snapshot('usable'), gitSha: sha, schemaVersion: 4, createdAt: '2026-08-02T08:00:00.000Z' }
    await store.write(usable)
    await store.write(stale)

    const head = { ...snapshot('head'), schemaVersion: 4 }
    expect((await store.resolve(sha, root, head))?.buildId).toBe('usable')
    // With no head to compare against there is nothing to prefer, so the newest wins.
    expect((await store.resolve(sha, root))?.buildId).toBe('stale')
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
