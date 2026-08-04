import { describe, expect, it } from 'vitest'
import { renderComment } from '../src/ci/comment.ts'
import { diffSnapshots } from '../src/diff/diff.ts'
import { buildLead } from '../src/diff/lead.ts'
import { renderDiffTerminal } from '../src/terminal-ui/views.tsx'
import { route, snapshot } from './factories.ts'

type Boundary = { file: string; component: string | null; bytes: number }
type Barrel = { file: string; bytes: number; dragged: string[] }

/** Two routes sharing a boundary, so grouping has something to group. */
function boundaryPair(before: Boundary[], after: Boundary[], headBytes = 184_000) {
  const routes = (boundaries: Boundary[], bytes: number) => [
    route({ id: 'app/a/page.tsx', pattern: '/a', clientBoundaries: boundaries, firstLoadBytes: bytes }),
    route({ id: 'app/b/page.tsx', pattern: '/b', clientBoundaries: boundaries, firstLoadBytes: bytes }),
  ]
  return {
    base: snapshot({ buildId: 'b'.repeat(16), routes: routes(before, 100_000) }),
    head: snapshot({ buildId: 'h'.repeat(16), routes: routes(after, headBytes) }),
  }
}

function barrelPair(before: Barrel[], after: Barrel[]) {
  const routes = (barrels: Barrel[], bytes: number) => [
    route({ id: 'app/a/page.tsx', pattern: '/a', barrels, firstLoadBytes: bytes }),
  ]
  return {
    base: snapshot({ buildId: 'b'.repeat(16), routes: routes(before, 100_000) }),
    head: snapshot({ buildId: 'h'.repeat(16), routes: routes(after, 140_000) }),
  }
}

const PROVIDER = { file: 'components/Provider.tsx', component: 'Provider', bytes: 84_000 }

describe('client-boundary comparison', () => {
  it('states one boundary once, with the routes it reached', () => {
    const { base, head } = boundaryPair([], [PROVIDER])
    const boundary = diffSnapshots(base, head).clientBoundaries[0]!

    expect(boundary).toMatchObject({
      file: 'components/Provider.tsx',
      component: 'Provider',
      status: 'added',
      delta: 84_000,
      before: 0,
      after: 84_000,
    })
    expect(boundary.routes.map((r) => r.pattern)).toEqual(['/a', '/b'])
  })

  it('reports the worst route, never the sum across routes', () => {
    // Two routes each mount the provider; the cost each page pays is 84 kB, and
    // 168 kB is bytes nobody downloads.
    const { base, head } = boundaryPair([], [PROVIDER])
    expect(diffSnapshots(base, head).clientBoundaries[0]!.delta).toBe(84_000)
  })

  it('keeps the component name when only one side carries it', () => {
    const withoutName = { file: 'components/Provider.tsx', component: null, bytes: 40_000 }
    const { base, head } = boundaryPair([withoutName], [PROVIDER])
    expect(diffSnapshots(base, head).clientBoundaries[0]!.component).toBe('Provider')
  })

  it('treats a boundary that went back to the server as an improvement', () => {
    const { base, head } = boundaryPair([PROVIDER], [], 20_000)
    const boundary = diffSnapshots(base, head).clientBoundaries[0]!

    expect(boundary.status).toBe('removed')
    expect(boundary.delta).toBe(-84_000)
    // Nothing to do about a fixed thing.
    const cause = buildLead(head, diffSnapshots(base, head)).causes.find((c) => c.kind === 'boundary')
    expect(cause?.action).toBeNull()
  })

  it('ignores movement inside the noise floor', () => {
    const { base, head } = boundaryPair(
      [{ ...PROVIDER, bytes: 84_000 }],
      [{ ...PROVIDER, bytes: 84_100 }],
    )
    expect(diffSnapshots(base, head).clientBoundaries).toEqual([])
  })

  it('names the component and the fix in both surfaces', () => {
    const { base, head } = boundaryPair([], [PROVIDER])
    const diff = diffSnapshots(base, head)

    const comment = renderComment(head, diff, [])
    expect(comment).toContain('`<Provider>` became a client boundary')
    expect(comment).toContain("move only the interactive part behind `'use client'`")
    // Backticked in the action too: a bare `<Provider>` is an HTML tag in Markdown
    // and GitHub renders it as nothing.
    expect(comment).toContain('`<Provider>` pulls its whole subtree')
    expect(comment).not.toMatch(/[^`]<Provider>/)

    const terminal = renderDiffTerminal(diff, 96)
    expect(terminal).toContain('<Provider>')
    expect(terminal).toContain('client boundary')
  })

  it('replaces the route detail it fully explains', () => {
    // Both routes gained exactly the boundary's bytes, so the blocks would repeat
    // the line above them.
    const { base, head } = boundaryPair([], [PROVIDER])
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment.match(/`<Provider>` became a client boundary/g)).toHaveLength(1)
    expect(comment).not.toContain('**`/a`**')
    expect(comment).not.toContain('**`/b`**')
    expect(comment).toContain('2 regressed routes, each explained by the causes above')
  })
})

describe('barrel comparison', () => {
  it('states the drag cost and what it started dragging', () => {
    const { base, head } = barrelPair(
      [{ file: 'components/index.ts', bytes: 10_000, dragged: ['components/Hero.tsx'] }],
      [
        {
          file: 'components/index.ts',
          bytes: 50_000,
          dragged: ['components/Hero.tsx', 'components/Gallery.tsx', 'components/Chart.tsx'],
        },
      ],
    )
    const barrel = diffSnapshots(base, head).barrels[0]!

    expect(barrel).toMatchObject({ file: 'components/index.ts', delta: 40_000, draggedBefore: 1, draggedAfter: 3 })
    expect(barrel.newlyDragged).toEqual(['components/Gallery.tsx', 'components/Chart.tsx'])
  })

  it('names the import style as the fix, not the files', () => {
    const { base, head } = barrelPair(
      [],
      [{ file: '@repo/ui', bytes: 40_000, dragged: ['a.tsx', 'b.tsx'] }],
    )
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment).toContain('`@repo/ui` barrel import added')
    expect(comment).toContain('reach this route only through `@repo/ui`')
    expect(comment).toContain('Import them directly')
  })

  it('ignores movement inside the noise floor', () => {
    const { base, head } = barrelPair(
      [{ file: 'components/index.ts', bytes: 10_000, dragged: [] }],
      [{ file: 'components/index.ts', bytes: 10_100, dragged: [] }],
    )
    expect(diffSnapshots(base, head).barrels).toEqual([])
  })
})

describe('barrel identity and overlap', () => {
  it('finds the baseline through a route alias, so old drag is not reported as new', () => {
    // The page moved and its URL changed with it. Both sides are keyed on the
    // aliased trend key; looking the baseline up by the head's pattern finds nothing
    // and reports every file the barrel already dragged as newly dragged.
    const barrel = (bytes: number, dragged: string[]) => [{ file: 'components/index.ts', bytes, dragged }]
    const base = snapshot({
      buildId: 'b'.repeat(16),
      routes: [route({ id: 'app/old/page.tsx', pattern: '/old', barrels: barrel(20_000, ['a.tsx', 'b.tsx']), firstLoadBytes: 100_000 })],
    })
    const head = snapshot({
      buildId: 'h'.repeat(16),
      routes: [route({ id: 'app/new/page.tsx', pattern: '/new', barrels: barrel(60_000, ['a.tsx', 'b.tsx', 'c.tsx']), firstLoadBytes: 140_000 })],
    })

    const found = diffSnapshots(base, head, { 'app/old/page.tsx': 'app/new/page.tsx' }).barrels[0]!
    expect(found.draggedBefore).toBe(2)
    expect(found.newlyDragged).toEqual(['c.tsx'])
  })

  it('does not add up nested barrels that may count the same files', () => {
    // `components/ui/index.ts` sits inside `components/index.ts`, so its 30 kB is
    // probably part of the other's 40 kB. Summing them explains 70 kB of a 60 kB
    // regression and suppresses the block; the largest single one explains 40 kB and
    // leaves the remaining 20 kB to the route's own detail.
    const barrels = (outer: number, inner: number) => [
      { file: 'components/index.ts', bytes: outer, dragged: ['a.tsx', 'b.tsx'] },
      { file: 'components/ui/index.ts', bytes: inner, dragged: ['b.tsx'] },
    ]
    const base = snapshot({
      buildId: 'b'.repeat(16),
      routes: [route({ id: 'app/a/page.tsx', pattern: '/a', barrels: barrels(10_000, 5_000), firstLoadBytes: 100_000 })],
    })
    const head = snapshot({
      buildId: 'h'.repeat(16),
      routes: [route({ id: 'app/a/page.tsx', pattern: '/a', barrels: barrels(50_000, 35_000), firstLoadBytes: 160_000 })],
    })
    const comment = renderComment(head, diffSnapshots(base, head), [])

    expect(comment).toContain('**`/a`**')
  })
})

describe('actions are chosen by what a cause did on the route in front of you', () => {
  it('prefers the cause that moved this route, not the one that is biggest elsewhere', () => {
    // `moment` is 200 kB on `/heavy` and 1 kB here; the boundary is 50 kB here. The
    // fix a reader needs is the boundary's.
    const base = snapshot({
      buildId: 'b'.repeat(16),
      routes: [
        route({ id: 'app/a/page.tsx', pattern: '/a', firstLoadBytes: 100_000 }),
        route({ id: 'app/heavy/page.tsx', pattern: '/heavy', firstLoadBytes: 100_000 }),
      ],
    })
    const head = snapshot({
      buildId: 'h'.repeat(16),
      routes: [
        route({
          id: 'app/a/page.tsx',
          pattern: '/a',
          firstLoadBytes: 151_000,
          dependencies: { moment: 1_000 },
          clientBoundaries: [{ file: 'components/Chart.tsx', component: 'Chart', bytes: 50_000 }],
        }),
        route({ id: 'app/heavy/page.tsx', pattern: '/heavy', firstLoadBytes: 300_000, dependencies: { moment: 200_000 } }),
      ],
    })

    const lead = buildLead(head, diffSnapshots(base, head))
    const onA = lead.changes.find((change) => change.route === '/a')
    expect(onA?.action).toContain('`<Chart>`')
    expect(onA?.action).not.toContain('moment')
  })
})

describe('axes that nest do not over-explain a route', () => {
  it('credits the largest axis rather than the sum of overlapping ones', () => {
    // The boundary's subtree cost *contains* the package it imports. Summing both
    // would explain 96 kB of a 48 kB regression and suppress a block for movement
    // nothing named; taking the largest single axis keeps that honest.
    const routes = (deps: Record<string, number>, boundaries: Boundary[], bytes: number) => [
      route({ id: 'app/a/page.tsx', pattern: '/a', dependencies: deps, clientBoundaries: boundaries, firstLoadBytes: bytes }),
    ]
    const base = snapshot({ buildId: 'b'.repeat(16), routes: routes({}, [], 100_000) })
    const head = snapshot({
      buildId: 'h'.repeat(16),
      routes: routes(
        { 'date-fns': 48_000 },
        [{ file: 'components/Chart.tsx', component: 'Chart', bytes: 48_000 }],
        196_000,
      ),
    })
    const comment = renderComment(head, diffSnapshots(base, head), [])

    // The route gained 96 kB; the largest single axis explains 48 kB of it, so the
    // block stays for the rest.
    expect(comment).toContain('**`/a`**')
  })
})
