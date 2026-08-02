import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/diff/diff.ts'
import { checkBudgets } from '../src/ci/budgets.ts'
import { renderComment } from '../src/ci/comment.ts'
import { route, snapshot } from './factories.ts'
import type { RouteSnapshot, Snapshot } from '../src/store/snapshot.ts'



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

describe('rendering-mode changes', () => {
  // The regression the whole tool exists for: no build error, not one byte moved,
  // and the route stopped being served from the edge. Before this was detected it
  // computed as `unchanged` and CI exited zero.
  const staticRoute = route({ renderingMode: 'STATIC' })
  const dynamicRoute = route({
    renderingMode: 'DYNAMIC',
    renderingModeReason: 'cookies() at app/page.tsx:18',
    dynamicReasons: ['cookies() at app/page.tsx:18'],
  })

  it('is a regression even when no byte changed', () => {
    const delta = diffSnapshots(snapshot({ routes: [staticRoute] }), snapshot({ routes: [dynamicRoute] })).routes[0]
    expect(delta?.status).toBe('changed')
    expect(delta?.severity).toBe('regression')
    expect(delta?.modeChange).toMatchObject({ before: 'STATIC', after: 'DYNAMIC', direction: 'regression' })
  })

  it('fails CI with no budget file at all', () => {
    const diff = diffSnapshots(snapshot({ routes: [staticRoute] }), snapshot({ routes: [dynamicRoute] }))
    const breaches = checkBudgets(snapshot({ routes: [dynamicRoute] }), null, diff)
    expect(breaches.map((b) => b.kind)).toContain('rendering-mode')
    expect(breaches.find((b) => b.kind === 'rendering-mode')?.message).toBe('rendering mode dropped static -> dynamic')
  })

  it('names the call site that caused the drop', () => {
    const diff = diffSnapshots(snapshot({ routes: [staticRoute] }), snapshot({ routes: [dynamicRoute] }))
    expect(diff.routes[0]?.cause).toMatchObject({ kind: 'dynamic-api', what: 'cookies() at app/page.tsx:18', site: 'app/page.tsx:18' })
  })

  it('treats getting more static as an improvement, and does not fail CI', () => {
    const diff = diffSnapshots(snapshot({ routes: [dynamicRoute] }), snapshot({ routes: [staticRoute] }))
    expect(diff.routes[0]?.modeChange?.direction).toBe('improvement')
    expect(diff.routes[0]?.severity).toBe('improvement')
    expect(checkBudgets(snapshot({ routes: [staticRoute] }), null, diff)).toEqual([])
  })

  it('refuses to call a direction when one side is unknown', () => {
    // `unknown` has no place on the staticness scale. Failing a build on a
    // direction we could not determine is the false positive that gets a check
    // switched off, so it is reported and not enforced.
    const before = route({ renderingMode: 'unknown', renderingModeReason: 'not prerendered, and no dynamic API found in source' })
    const diff = diffSnapshots(snapshot({ routes: [before] }), snapshot({ routes: [dynamicRoute] }))
    expect(diff.routes[0]?.modeChange?.direction).toBe('unknown')
    expect(checkBudgets(snapshot({ routes: [dynamicRoute] }), null, diff).map((b) => b.kind)).not.toContain('rendering-mode')
  })

  it('is exempt when the route is listed in allowRegression', () => {
    const diff = diffSnapshots(snapshot({ routes: [staticRoute] }), snapshot({ routes: [dynamicRoute] }))
    const breaches = checkBudgets(snapshot({ routes: [dynamicRoute] }), { allowRegression: ['/'] }, diff)
    expect(breaches).toEqual([])
  })

  it('does not let allowRegression switch off a budget the project wrote down', () => {
    // The exemption covers the rules crust turned on by itself. A `maxGrowth`
    // number is an explicit decision, and overriding it here would be an implicit
    // one silently winning.
    const base = snapshot({ routes: [route({ renderingMode: 'STATIC', firstLoadBytes: 100_000 })] })
    const head = snapshot({
      routes: [route({ renderingMode: 'DYNAMIC', renderingModeReason: 'cookies() at app/page.tsx:18', firstLoadBytes: 200_000 })],
    })

    const breaches = checkBudgets(head, { allowRegression: ['/'], maxGrowth: 0.1 }, diffSnapshots(base, head))
    expect(breaches.map((b) => b.kind)).toEqual(['growth'])
  })

  it('reports a partial route losing its shell entirely', () => {
    const before = route({
      renderingMode: 'PARTIALLY_STATIC',
      shell: { predictedStatic: [], predictedHoles: [], actual: { htmlPath: 'x', bytes: 900, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.8 }, agreement: 1, unknown: [] },
    })
    const after = route({ renderingMode: 'PARTIALLY_STATIC', shell: null })
    const diff = diffSnapshots(snapshot({ routes: [before] }), snapshot({ routes: [after] }))

    expect(diff.routes[0]?.severity).toBe('regression')
    const breaches = checkBudgets(snapshot({ routes: [after] }), null, diff)
    expect(breaches.find((b) => b.kind === 'shell-ratio')?.message).toBe('no static shell is emitted any more (was 80%)')
  })
})

describe('cache regressions', () => {
  const cached = route({ renderingMode: 'PARTIALLY_STATIC' })
  const uncached = route({
    renderingMode: 'PARTIALLY_STATIC',
    dynamicReasons: ['uncached fetch at lib/http.ts:3 via lib/products.ts'],
    shell: {
      predictedStatic: [],
      predictedHoles: [{ component: 'ProductGallery', boundary: 'app/page.tsx:12', reason: 'uncached fetch at lib/http.ts:3' }],
      actual: null,
      agreement: null,
      unknown: [],
    },
  })

  it('fails CI when a read stops being cached, with no budget file', () => {
    const diff = diffSnapshots(snapshot({ routes: [cached] }), snapshot({ routes: [uncached] }))
    const breaches = checkBudgets(snapshot({ routes: [uncached] }), null, diff)
    expect(breaches.find((b) => b.kind === 'cache')?.message).toBe('stopped being cached: uncached fetch at lib/http.ts:3')
  })

  it('blames the component, not just the file', () => {
    const diff = diffSnapshots(snapshot({ routes: [cached] }), snapshot({ routes: [uncached] }))
    expect(diff.routes[0]?.cause).toMatchObject({
      kind: 'cache',
      what: 'uncached fetch at lib/http.ts:3',
      component: 'ProductGallery',
    })
  })

  it('collapses the same call site reached by different import paths', () => {
    // The ` via …` tail differs per route; the fetch that has to be fixed does not.
    const viaA = route({ dynamicReasons: ['uncached fetch at lib/http.ts:3 via lib/a.ts'] })
    const viaB = route({ dynamicReasons: ['uncached fetch at lib/http.ts:3 via lib/b.ts'] })
    const diff = diffSnapshots(snapshot({ routes: [viaA] }), snapshot({ routes: [viaB] }))
    expect(diff.routes[0]?.cacheChange).toBeNull()
    expect(diff.routes[0]?.status).toBe('unchanged')
  })

  it('reports a moved ISR window without ranking it', () => {
    const before = route({ renderingMode: 'ISR', renderingModeReason: 'revalidate=60' })
    const after = route({ renderingMode: 'ISR', renderingModeReason: 'revalidate=3600' })
    const diff = diffSnapshots(snapshot({ routes: [before] }), snapshot({ routes: [after] }))

    expect(diff.routes[0]?.cacheChange?.revalidate).toEqual({ before: 60, after: 3600 })
    expect(diff.routes[0]?.severity).toBe('neutral')
    expect(checkBudgets(snapshot({ routes: [after] }), null, diff)).toEqual([])
  })

  it('credits a read that started being cached', () => {
    const diff = diffSnapshots(snapshot({ routes: [uncached] }), snapshot({ routes: [cached] }))
    // Named once, by its call site - not once per import path that reaches it.
    expect(diff.routes[0]?.cacheChange?.resolved).toEqual(['uncached fetch at lib/http.ts:3'])
    expect(diff.routes[0]?.severity).toBe('improvement')
  })
})

describe('when the two builds are not comparable', () => {
  // Changing bundler or Next major moves every number for reasons that have
  // nothing to do with the PR. Failing it would fail the one change least able to
  // do anything about it.
  const staticRoute = route({ renderingMode: 'STATIC' })
  const dynamicRoute = route({ renderingMode: 'DYNAMIC', renderingModeReason: 'cookies() at app/page.tsx:18' })

  const incomparable = () =>
    diffSnapshots(
      snapshot({ routes: [staticRoute] }),
      snapshot({ routes: [dynamicRoute], bundler: 'turbopack' }),
    )

  it('runs no regression check', () => {
    const diff = incomparable()
    expect(diff.incomparable).not.toHaveLength(0)
    expect(checkBudgets(snapshot({ routes: [dynamicRoute] }), null, diff)).toEqual([])
  })

  it('still enforces ceilings, which describe this build alone', () => {
    const breaches = checkBudgets(
      snapshot({ routes: [route({ firstLoadBytes: 600_000 })] }),
      { defaultFirstLoadBytes: 500_000 },
      incomparable(),
    )
    expect(breaches.map((b) => b.kind)).toEqual(['first-load'])
  })

  it('does not print a delta it has just said it cannot report', () => {
    const comment = renderComment(snapshot({ routes: [dynamicRoute] }), incomparable(), [])
    expect(comment).toContain('no deltas are reported and no regression')
    expect(comment).not.toContain('- Cause:')
    expect(comment).not.toContain('- rendering:')
    expect(comment).toContain('### crust: baseline not comparable, so nothing to compare')
  })

  it('says "no baseline yet" rather than "not comparable" on a first run', () => {
    expect(renderComment(snapshot(), null, [])).toContain('### crust: no baseline yet')
  })
})

describe('added routes', () => {
  it('is not a regression, because there was nothing to get worse than', () => {
    // `firstLoadBefore` is 0 for a new route, so every normal page clears the
    // growth floor and would otherwise be announced as a regression.
    const head = snapshot({ routes: [route(), route({ id: 'app/new/page.tsx', pattern: '/new' })] })
    const delta = diffSnapshots(snapshot(), head).routes.find((r) => r.pattern === '/new')

    expect(delta?.status).toBe('added')
    expect(delta?.severity).toBe('neutral')
    expect(checkBudgets(head, null, diffSnapshots(snapshot(), head))).toEqual([])
  })

  it('can still breach an absolute ceiling, which is not a regression', () => {
    const head = snapshot({ routes: [route({ id: 'app/new/page.tsx', pattern: '/new', firstLoadBytes: 600_000 })] })
    const breaches = checkBudgets(head, { defaultFirstLoadBytes: 500_000 }, diffSnapshots(snapshot(), head))
    expect(breaches.map((b) => b.kind)).toEqual(['first-load'])
  })
})

describe('noise', () => {
  it('does not call a content-hash-sized change a regression', () => {
    const base = snapshot({ routes: [route({ firstLoadBytes: 100_000 })] })
    const head = snapshot({ routes: [route({ firstLoadBytes: 100_200 })] })
    const delta = diffSnapshots(base, head).routes[0]

    // The change is real and still recorded - it is just not worth a reviewer's
    // attention, and a comment that flags it is a comment people stop reading.
    expect(delta?.status).toBe('changed')
    expect(delta?.severity).toBe('neutral')
    expect(delta?.cause).toBeNull()
  })

  it('says so plainly when a route grew and nothing can be blamed', () => {
    const base = snapshot({ routes: [route({ firstLoadBytes: 100_000 })] })
    const head = snapshot({ routes: [route({ firstLoadBytes: 200_000 })] })
    expect(diffSnapshots(base, head).routes[0]?.cause).toMatchObject({ kind: 'unknown' })
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

  it('prints the cause and the component for a regressed route', () => {
    const before = snapshot({
      routes: [route({ shell: { predictedStatic: ['ProductGallery'], predictedHoles: [], actual: { htmlPath: 'x', bytes: 1, holes: 0, boundaryIds: [], shellRatio: 1 }, agreement: 1, unknown: [] } })],
    })
    const after = snapshot({
      routes: [
        route({
          pattern: '/products/[slug]',
          shell: {
            predictedStatic: [],
            predictedHoles: [{ component: 'ProductGallery', boundary: 'app/page.tsx:12', reason: 'uncached fetch at lib/http.ts:3' }],
            actual: { htmlPath: 'x', bytes: 1, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.45 },
            agreement: 1,
            unknown: [],
          },
        }),
      ],
    })

    const comment = renderComment(after, diffSnapshots(before, after), [])
    expect(comment).toContain('**`/products/[slug]`**')
    expect(comment).toContain('- static shell: **100% → 45%**')
    expect(comment).toContain('- Cause: `uncached fetch at lib/http.ts:3`')
    expect(comment).toContain('- Introduced by: `<ProductGallery>`')
  })

  it('leads with the route that stopped being static', () => {
    const before = snapshot({ routes: [route({ renderingMode: 'STATIC' })] })
    const after = snapshot({
      routes: [route({ renderingMode: 'DYNAMIC', renderingModeReason: 'cookies() at app/page.tsx:18' })],
    })
    const comment = renderComment(after, diffSnapshots(before, after), [])
    expect(comment).toContain('### crust: `/` is no longer static')
    expect(comment).toContain('- rendering: **static → dynamic**')
  })

  it('stays quiet about routes that only moved a few bytes', () => {
    const before = snapshot({ routes: [route({ firstLoadBytes: 100_000 })] })
    const after = snapshot({ routes: [route({ firstLoadBytes: 100_200 })] })
    const comment = renderComment(after, diffSnapshots(before, after), [])

    // It is behind a fold, not on the reviewer's screen.
    expect(comment).toContain('### crust: 1 route changed, nothing regressed')
    expect(comment).toContain('<details><summary>1 other route changed</summary>')
    expect(comment).not.toContain('- Cause:')
  })
})
