import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/diff/diff.ts'
import { checkBudgets } from '../src/ci/budgets.ts'
import { renderComment } from '../src/ci/comment.ts'
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

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    toolVersion: '0.1.0',
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
    routes: [route()],
    modules: {},
    warnings: [],
    ...overrides,
  }
}

describe('diffSnapshots', () => {
  it('names the module responsible for a size change', () => {
    const base = snapshot({ routes: [route({ modules: { 'lib/a.ts': 1_000 } })] })
    const head = snapshot({
      buildId: 'bbbbbbbbbbbbbbbb',
      routes: [route({ firstLoadBytes: 150_000, modules: { 'lib/a.ts': 1_000, 'lib/heavy.ts': 49_000 } })],
    })

    const diff = diffSnapshots(base, head)
    expect(diff.routes[0]?.firstLoadDelta).toBe(50_000)
    expect(diff.routes[0]?.modules[0]).toMatchObject({ file: 'lib/heavy.ts', delta: 49_000, status: 'added' })
  })

  it('keys routes on file path, not URL pattern', () => {
    // A rename of the URL must not read as "old route deleted, new route added",
    // or the history restarts on every refactor.
    const base = snapshot({ routes: [route({ pattern: '/old' })] })
    const head = snapshot({ routes: [route({ pattern: '/new', firstLoadBytes: 110_000 })] })

    const diff = diffSnapshots(base, head)
    expect(diff.routes).toHaveLength(1)
    expect(diff.routes[0]?.status).toBe('changed')
  })

  it('refuses to compare across bundlers', () => {
    const diff = diffSnapshots(snapshot(), snapshot({ bundler: 'turbopack' }))
    expect(diff.incomparable).toContain('bundler changed: webpack -> turbopack')
  })

  it('refuses to compare across Next majors', () => {
    const diff = diffSnapshots(snapshot({ nextVersion: '15.4.0' }), snapshot())
    expect(diff.incomparable[0]).toMatch(/Next major changed/)
  })

  it('reports a component that left the shell', () => {
    const before = route({
      shell: { predictedStatic: ['Gallery'], predictedHoles: [], actual: null, agreement: null, unknown: [] },
    })
    const after = route({
      shell: {
        predictedStatic: [],
        predictedHoles: [{ component: 'Gallery', boundary: 'app/page.tsx:12', reason: 'uncached fetch at lib/http.ts:3' }],
        actual: null,
        agreement: null,
        unknown: [],
      },
    })

    const diff = diffSnapshots(snapshot({ routes: [before] }), snapshot({ routes: [after] }))
    expect(diff.routes[0]?.newHoles).toEqual([
      { component: 'Gallery', reason: 'uncached fetch at lib/http.ts:3' },
    ])
  })
})

describe('checkBudgets', () => {
  const withShell = route({
    firstLoadBytes: 600_000,
    shell: {
      predictedStatic: [],
      predictedHoles: [{ component: 'Theme', boundary: 'app/page.tsx:9', reason: 'cookies() at app/page.tsx:18' }],
      actual: { htmlPath: 'server/app/index.html', bytes: 900, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.3 },
      agreement: 1,
      unknown: [],
    },
  })

  it('breaches on first-load size', () => {
    const breaches = checkBudgets(snapshot({ routes: [withShell] }), { defaultFirstLoadBytes: 500_000 }, null)
    expect(breaches.map((b) => b.kind)).toContain('first-load')
  })

  it('breaches on shell ratio and blames the call site', () => {
    const breaches = checkBudgets(snapshot({ routes: [withShell] }), { defaultMinShellRatio: 0.5 }, null)
    const shell = breaches.find((b) => b.kind === 'shell-ratio')
    expect(shell?.blame).toBe('cookies() at app/page.tsx:18')
  })

  it('breaches on growth relative to the baseline', () => {
    const base = snapshot({ routes: [route({ firstLoadBytes: 100_000 })] })
    const head = snapshot({ routes: [route({ firstLoadBytes: 130_000 })] })
    const breaches = checkBudgets(head, { maxGrowth: 0.1 }, diffSnapshots(base, head))
    expect(breaches.map((b) => b.kind)).toContain('growth')
  })

  it('passes when nothing is configured', () => {
    expect(checkBudgets(snapshot(), {}, null)).toEqual([])
  })
})

describe('renderComment', () => {
  it('carries a stable marker so the action can update in place', () => {
    expect(renderComment(snapshot(), null, [])).toContain('<!-- crust-report -->')
  })

  it('leads with the shell when the shell shrank', () => {
    const base = snapshot({
      routes: [route({ shell: { predictedStatic: [], predictedHoles: [], actual: { htmlPath: 'x', bytes: 1, holes: 0, boundaryIds: [], shellRatio: 1 }, agreement: 1, unknown: [] } })],
    })
    const head = snapshot({
      routes: [route({ shell: { predictedStatic: [], predictedHoles: [], actual: { htmlPath: 'x', bytes: 1, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.45 }, agreement: 1, unknown: [] } })],
    })
    expect(renderComment(head, diffSnapshots(base, head), [])).toContain('static shell shrank on 1 route')
  })
})
