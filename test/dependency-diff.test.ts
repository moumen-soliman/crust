import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/diff/diff.ts'
import { renderComment } from '../src/ci/comment.ts'
import { route, snapshot } from './factories.ts'

/** Two routes sharing a package, so grouping has something to group. */
function pair(before: Record<string, number>, after: Record<string, number>, headBytes = 148_000) {
  const routes = (deps: Record<string, number>, bytes: number) => [
    route({ id: 'app/cart/page.tsx', pattern: '/cart', dependencies: deps, firstLoadBytes: bytes }),
    route({ id: 'app/checkout/page.tsx', pattern: '/checkout', dependencies: deps, firstLoadBytes: bytes }),
  ]
  return {
    base: snapshot({ buildId: 'b'.repeat(16), routes: routes(before, 100_000) }),
    head: snapshot({ buildId: 'h'.repeat(16), routes: routes(after, headBytes) }),
  }
}

/**
 * One package per route, worst first, so suppression can be judged one route at
 * a time. `count` above the comment's package limit puts the last package behind
 * a count instead of on a line.
 */
function perRoutePackages(count: number) {
  const bytesFor = (index: number) => 60_000 - index * 1_000
  const routes = (withPackages: boolean) =>
    Array.from({ length: count }, (_, index) =>
      route({
        id: `app/r${index}/page.tsx`,
        pattern: `/r${index}`,
        firstLoadBytes: 100_000 + (withPackages ? bytesFor(index) : 0),
        dependencies: withPackages ? { [`pkg-${index}`]: bytesFor(index) } : {},
      }),
    )
  return {
    base: snapshot({ buildId: 'b'.repeat(16), routes: routes(false) }),
    head: snapshot({ buildId: 'h'.repeat(16), routes: routes(true) }),
  }
}

/**
 * The heading `routeBlock` actually emits. Asserted through a helper because the
 * interesting assertions here are negative, and a negative match against a
 * heading the comment never writes passes whatever the code does.
 */
const block = (pattern: string) => `**\`${pattern}\`**`

describe('dependency diff', () => {
  it('states one package once, with the routes it reached', () => {
    const { base, head } = pair({}, { 'date-fns': 48_000 })
    const diff = diffSnapshots(base, head)

    expect(diff.dependencies).toHaveLength(1)
    const dep = diff.dependencies[0]!
    expect(dep.pkg).toBe('date-fns')
    expect(dep.status).toBe('added')
    expect(dep.routes).toEqual([
      { pattern: '/cart', delta: 48_000 },
      { pattern: '/checkout', delta: 48_000 },
    ])
  })

  it('reports the worst route, never the sum across routes', () => {
    const { base, head } = pair({}, { 'date-fns': 48_000 })

    // A shared chunk is counted in the first load of every route it serves.
    // Summing those would report 96 kB of download that nobody performs.
    expect(diffSnapshots(base, head).dependencies[0]!.delta).toBe(48_000)
  })

  it('treats a removal as an improvement rather than hiding it', () => {
    const { base, head } = pair({ moment: 84_000 }, {})
    const dep = diffSnapshots(base, head).dependencies[0]!

    expect(dep.status).toBe('removed')
    expect(dep.delta).toBe(-84_000)
  })

  it('ignores movement inside the noise floor', () => {
    const { base, head } = pair({ react: 40_000 }, { react: 40_100 })
    expect(diffSnapshots(base, head).dependencies).toEqual([])
  })

  it('replaces the route blocks it explains instead of preceding them', () => {
    const { base, head } = pair({}, { 'date-fns': 48_000 })
    const diff = diffSnapshots(base, head)
    const comment = renderComment(head, diff, [])

    // The package gets one cause line (the action beside it names it again, which
    // is the fix, not a restatement)...
    expect(comment.match(/`date-fns` added/g)).toHaveLength(1)
    // ...and the routes whose only cause is those bytes do not each restate it.
    expect(comment).not.toContain(block('/cart'))
    expect(comment).not.toContain(block('/checkout'))
    // They are still counted - suppressing the block must not hide the verdict.
    // Not "2 more": with every block suppressed there is nothing for them to be
    // more than.
    expect(comment).toContain('2 regressed routes, each explained by the causes above')
  })

  it('keeps a block when the package accounts for only part of the growth', () => {
    // 48 kB of a 200 kB gain. Dropping the block would answer the smaller half of
    // the regression and hide the larger one.
    const { base, head } = pair({}, { 'date-fns': 48_000 }, 300_000)
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment).toContain('date-fns')
    expect(comment).toContain(block('/cart'))
    expect(comment).toContain(block('/checkout'))
  })

  it('keeps a block when the package explaining it is behind the "more causes" count', () => {
    // Seven packages, six lines. The seventh is a count, and a count explains
    // nothing - so its route cannot lose the only statement of its cause.
    const { base, head } = perRoutePackages(7)
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment).toContain('… and 1 more cause')
    // Named on a line, and fully accounted for: no block.
    expect(comment).not.toContain(block('/r0'))
    // Behind the count: block kept.
    expect(comment).toContain(block('/r6'))
    // One block printed, seven regressions counted.
    expect(comment).toContain('6 more regressed routes')
  })

  it('reports before, after and status from the worst route, not from three routes', () => {
    // The metadata bug: `before` and `after` were per-package maxima collected
    // independently, so a package removed from one route and added to another
    // reported the larger before, the larger after, and `changed` - three numbers
    // describing no build that exists, with after - before ≠ the delta beside them.
    const routes = (a: Record<string, number>, b: Record<string, number>) => [
      route({ id: 'app/a/page.tsx', pattern: '/a', dependencies: a, firstLoadBytes: 100_000 }),
      route({ id: 'app/b/page.tsx', pattern: '/b', dependencies: b, firstLoadBytes: 100_000 }),
    ]
    const base = snapshot({ buildId: 'b'.repeat(16), routes: routes({ moment: 84_000 }, {}) })
    const head = snapshot({ buildId: 'h'.repeat(16), routes: routes({}, { moment: 20_000 }) })

    const dep = diffSnapshots(base, head).dependencies[0]!
    expect(dep.delta).toBe(-84_000)
    expect(dep).toMatchObject({ before: 84_000, after: 0, status: 'removed' })
    // The row is one route's fact, so its own arithmetic holds.
    expect(dep.after - dep.before).toBe(dep.delta)
  })

  it('splits a package that shrank on one route and grew on another', () => {
    // A provider moved out of one layout and into another does exactly this. One row
    // would take the worst route's direction, so the line would say "removed" while
    // covering a route where it was added - and suppressing that route's detail on
    // the strength of that line tells the reader the opposite of what happened.
    const routes = (a: Record<string, number>, b: Record<string, number>) => [
      route({ id: 'app/a/page.tsx', pattern: '/a', dependencies: a, firstLoadBytes: 100_000 }),
      route({ id: 'app/b/page.tsx', pattern: '/b', dependencies: b, firstLoadBytes: 100_000 }),
    ]
    const base = snapshot({ buildId: 'b'.repeat(16), routes: routes({ moment: 84_000 }, {}) })
    const head = snapshot({ buildId: 'h'.repeat(16), routes: routes({}, { moment: 48_000 }) })
    const deps = diffSnapshots(base, head).dependencies

    expect(deps).toHaveLength(2)
    expect(deps.map((dep) => [dep.status, dep.delta, dep.routes.map((r) => r.pattern)])).toEqual([
      ['removed', -84_000, ['/a']],
      ['added', 48_000, ['/b']],
    ])
    // Each row is one route's fact, and each covers only routes that moved its way.
    for (const dep of deps) expect(dep.after - dep.before).toBe(dep.delta)
  })

  it('says shrank, not grew, when a package got smaller', () => {
    const { base, head } = pair({ moment: 100_000 }, { moment: 50_000 }, 50_000)
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment).toContain('`moment` shrank')
    expect(comment).not.toContain('`moment` grew')
  })

  it('keeps a block when the route has a cause the package does not explain', () => {
    const { base, head } = pair({}, { 'date-fns': 48_000 })
    head.routes[0]!.renderingMode = 'DYNAMIC'
    head.routes[0]!.renderingModeReason = 'cookies() at app/cart/page.tsx:3'
    const comment = renderComment(head, diffSnapshots(base, head), [])

    // The mode drop is not something a package line explains, so the block stays.
    expect(comment).toContain(block('/cart'))
    expect(comment).toContain('cookies()')
    // The other route moved in bytes only, and those bytes are named above.
    expect(comment).not.toContain(block('/checkout'))
  })
})
