import { describe, expect, it } from 'vitest'
import { renderComment } from '../src/ci/comment.ts'
import { diffSnapshots } from '../src/diff/diff.ts'
import { buildLead } from '../src/diff/lead.ts'
import { renderDiffTerminal } from '../src/terminal-ui/views.tsx'
import { route, snapshot } from './factories.ts'

const REASON = 'uncached fetch at lib/http.ts:3'

/** A route that reads request state, so the head loses static rendering. */
const dynamic = (overrides: Parameters<typeof route>[0] = {}) =>
  route({ renderingMode: 'DYNAMIC', renderingModeReason: REASON, dynamicReasons: [REASON], ...overrides })

const pair = (baseRoutes: ReturnType<typeof route>[], headRoutes: ReturnType<typeof route>[]) => ({
  base: snapshot({ buildId: 'b'.repeat(16), routes: baseRoutes }),
  head: snapshot({ buildId: 'h'.repeat(16), routes: headRoutes }),
})

const lead = (baseRoutes: ReturnType<typeof route>[], headRoutes: ReturnType<typeof route>[], breaches = []) => {
  const { base, head } = pair(baseRoutes, headRoutes)
  return buildLead(head, diffSnapshots(base, head), breaches)
}

describe('lead: decision', () => {
  it('blocks on a rendering-mode drop and names the route', () => {
    const result = lead([route()], [dynamic()])

    expect(result.decision.level).toBe('block')
    expect(result.decision.headline).toBe('`/` is no longer static')
  })

  it('blocks on a budget breach even when no route regressed', () => {
    const result = lead([route()], [route()], [
      { pattern: '/', message: 'first load 160 kB over the 120 kB ceiling' },
    ] as never)

    expect(result.decision.level).toBe('block')
    expect(result.decision.headline).toBe('1 budget breach')
  })

  it('asks for review when routes grew with nothing blocking', () => {
    const result = lead([route({ firstLoadBytes: 100_000 })], [route({ firstLoadBytes: 160_000 })])

    expect(result.decision.level).toBe('review')
    expect(result.decision.headline).toBe('1 route grew')
  })

  it('states improvements as the decision when nothing regressed', () => {
    // The half of the job a failures-only tool cannot do: saying the refactor
    // worked. This used to read "1 route changed, nothing regressed".
    const result = lead([route({ firstLoadBytes: 200_000 })], [route({ firstLoadBytes: 120_000 })])

    expect(result.decision.level).toBe('clear')
    expect(result.decision.headline).toBe('1 route improved, nothing regressed')
  })

  it('refuses to decide without a comparable baseline', () => {
    const { head } = pair([route()], [route()])
    expect(buildLead(head, null).decision).toEqual({
      level: 'undecidable',
      headline: 'no baseline yet, so nothing to compare',
    })

    const incomparable = diffSnapshots(snapshot({ bundler: 'turbopack' }), snapshot({ bundler: 'webpack' }))
    expect(buildLead(head, incomparable).decision.level).toBe('undecidable')
    expect(buildLead(head, incomparable).coverage).toBeNull()
  })
})

describe('lead: changes', () => {
  it('names regressions first and keeps improvements in the same list', () => {
    const result = lead(
      [
        route({ id: 'a', pattern: '/a', firstLoadBytes: 100_000 }),
        route({ id: 'b', pattern: '/b', firstLoadBytes: 200_000 }),
      ],
      [
        route({ id: 'a', pattern: '/a', firstLoadBytes: 160_000 }),
        route({ id: 'b', pattern: '/b', firstLoadBytes: 120_000 }),
      ],
    )

    expect(result.changes.map((change) => [change.direction, change.route])).toEqual([
      ['regression', '/a'],
      ['improvement', '/b'],
    ])
  })

  it('ranks a route that became static again above one that shed bytes', () => {
    const result = lead(
      [
        dynamic({ id: 'a', pattern: '/a' }),
        route({ id: 'b', pattern: '/b', firstLoadBytes: 400_000 }),
      ],
      [
        route({ id: 'a', pattern: '/a' }),
        route({ id: 'b', pattern: '/b', firstLoadBytes: 120_000 }),
      ],
    )

    expect(result.changes[0]).toMatchObject({ direction: 'improvement', route: '/a' })
    expect(result.changes[0]!.headline).toContain('became static')
  })

  it('names one route per shared cause rather than three faces of one problem', () => {
    const ids = ['a', 'b', 'c']
    const result = lead(
      ids.map((id) => route({ id, pattern: `/${id}` })),
      ids.map((id) => dynamic({ id, pattern: `/${id}` })),
    )

    // Three routes, one call site, three lead lines' worth of space. The radius is
    // the shared cause's job.
    expect(result.changes).toHaveLength(1)
    expect(result.causes[0]).toMatchObject({ kind: 'site', label: 'lib/http.ts:3' })
    expect(result.causes[0]!.routes).toEqual(['/a', '/b', '/c'])
  })

  it('carries the strongest source location it has, and no location it does not', () => {
    const withSite = lead([route()], [dynamic()])
    expect(withSite.changes[0]!.where).toBe('lib/http.ts:3')

    const bytesOnly = lead(
      [route({ firstLoadBytes: 100_000 })],
      [route({ firstLoadBytes: 160_000, modules: { 'components/Hero.tsx': 60_000 } })],
    )
    expect(bytesOnly.changes[0]!.where).toBe('components/Hero.tsx')
  })
})

describe('lead: action', () => {
  it('names the fix for a cache-driven mode drop', () => {
    expect(lead([route()], [dynamic()]).changes[0]!.action).toContain('use cache')
  })

  it('does not tell a partial route to wrap a read that is already behind Suspense', () => {
    // Two real builds: static `/` → partial via `<Theme>` + `cookies()` inside
    // Suspense. The old action repeated the step the author had already taken.
    const cookiesReason = 'cookies() at app/page.tsx:6'
    const partial = route({
      renderingMode: 'PARTIALLY_STATIC',
      renderingModeReason: cookiesReason,
      dynamicReasons: [cookiesReason],
      shell: {
        predictedStatic: [],
        predictedHoles: [{ component: 'Theme', boundary: 'Theme', reason: cookiesReason }],
        actual: { htmlPath: 'x', bytes: 1, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.48 },
        agreement: 1,
        unknown: [],
      },
    })
    const action = lead([route()], [partial]).changes[0]!.action
    expect(action).toContain('use cache')
    expect(action).toContain('cookies()')
    expect(action).not.toContain('Suspense')
  })

  it('points at the package when bytes moved and a package explains them', () => {
    const result = lead(
      [route({ firstLoadBytes: 100_000 })],
      [route({ firstLoadBytes: 148_000, dependencies: { 'date-fns': 48_000 } })],
    )

    expect(result.changes[0]!.action).toContain('`date-fns`')
    expect(result.changes[0]!.action).toContain('next/dynamic')
  })

  it('says what evidence is missing instead of inventing an action', () => {
    // The rule the roadmap states outright: if it cannot answer why, it says
    // exactly what is missing. A build with no maps cannot name a file, and
    // "check your imports" would be an instruction with nothing behind it.
    const base = snapshot({ buildId: 'b'.repeat(16), routes: [route({ firstLoadBytes: 100_000 })] })
    const head = snapshot({
      buildId: 'h'.repeat(16),
      config: { cacheComponents: false, experimental: {}, sourceMaps: false },
      routes: [route({ firstLoadBytes: 160_000, unattributedBytes: 60_000 })],
    })
    const result = buildLead(head, diffSnapshots(base, head))

    expect(result.changes[0]!.action).toContain('no browser source maps')
    expect(result.coverage?.missing).toContain('productionBrowserSourceMaps')
  })

  it('leaves improvements without an action', () => {
    const result = lead([route({ firstLoadBytes: 200_000 })], [route({ firstLoadBytes: 120_000 })])
    expect(result.changes[0]).toMatchObject({ direction: 'improvement', action: null })
  })
})

describe('lead: coverage', () => {
  it('states the attributed share and flags a weak one', () => {
    const strong = lead(
      [route({ modules: { 'a.ts': 100_000 } })],
      [route({ modules: { 'a.ts': 140_000 }, firstLoadBytes: 140_000 })],
    )
    expect(strong.coverage).toMatchObject({ text: 'attribution 100%', weak: false })

    const weak = lead(
      [route({ modules: { 'a.ts': 100_000 } })],
      [route({ modules: { 'a.ts': 20_000 }, unattributedBytes: 140_000, firstLoadBytes: 160_000 })],
    )
    // 20 kB attributed of 160 kB.
    expect(weak.coverage).toMatchObject({ text: 'attribution 100% → 13%', weak: true })
  })
})

describe('lead: both commands lead with the same answer', () => {
  it('gives `diff` and `ci` the same decision sentence for the same pair', () => {
    const { base, head } = pair(
      [route({ id: 'a', pattern: '/a' }), route({ id: 'b', pattern: '/b', firstLoadBytes: 100_000 })],
      [dynamic({ id: 'a', pattern: '/a' }), route({ id: 'b', pattern: '/b', firstLoadBytes: 160_000 })],
    )
    const diff = diffSnapshots(base, head)
    const sentence = buildLead(head, diff).decision.headline

    // The sentence a reviewer reads first has to be one sentence, not one per
    // surface: a local run that disagrees with the PR comment is two tools.
    expect(renderComment(head, diff, [])).toContain(`### crust: ${sentence}`)
    expect(renderDiffTerminal(diff, 96)).toContain(sentence)
  })

  it('puts coverage beside the verdict in the comment as well as the terminal', () => {
    const { base, head } = pair(
      [route({ modules: { 'a.ts': 100_000 } })],
      [route({ modules: { 'a.ts': 160_000 }, firstLoadBytes: 160_000 })],
    )
    const diff = diffSnapshots(base, head)

    expect(renderComment(head, diff, [])).toContain('attribution 100%')
    expect(renderDiffTerminal(diff, 96)).toContain('attribution 100%')
  })

  it('states a shared cause once and stops repeating it per route', () => {
    const ids = ['a', 'b', 'c', 'd']
    const { base, head } = pair(
      ids.map((id) => route({ id, pattern: `/${id}` })),
      ids.map((id) => dynamic({ id, pattern: `/${id}` })),
    )
    const comment = renderComment(head, diffSnapshots(base, head), [])

    // One cause line, one action, and blocks for the worst two rather than all
    // four. Four blocks each ending in the same sentence is the shape the grouping
    // exists to remove.
    expect(comment).toContain('**Cause**')
    // The radius, stated once. (The footer's own "4 routes" is the build's size.)
    expect(comment.match(/· 4 routes:/g)).toHaveLength(1)
    expect(comment.match(/use cache/g)).toHaveLength(1)
    expect(comment).toContain('… and 2 more regressed routes')
  })
})
