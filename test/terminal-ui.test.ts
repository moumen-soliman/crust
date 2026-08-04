import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/diff/diff.ts'
import { route, snapshot as base } from './factories.ts'
import type { RouteSnapshot, Snapshot } from '../src/store/snapshot.ts'
import { renderDiffTerminal, renderSnapshotTerminal } from '../src/terminal-ui/views.tsx'

describe('terminal UI', () => {
  it('keeps analyze concise and hides the route inventory by default', () => {
    const output = renderSnapshotTerminal(
      snapshot([
        route({ pattern: '/a/very/long/route/name/that/needs/truncation', firstLoadBytes: 210_000 }),
        route({ pattern: '/small', firstLoadBytes: 80_000 }),
      ]),
      64,
    )

    expect(output).toContain('crust — 2 routes')
    expect(output).toContain('BUILD HEALTH')
    expect(output).toContain('Median first load')
    expect(output).toContain('Routes → crust analyze --routes')
    expect(output).not.toContain('First load │')
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(64)
  })

  it('reveals the complete route table only when requested', () => {
    const output = renderSnapshotTerminal(snapshot([route({ pattern: '/one' })]), { showRoutes: true }, 64)
    expect(output).toContain('ROUTES')
    expect(output).toContain('First load')
    expect(output).toContain('/one')
  })

  it('leads with regression cause, component, shell movement, and CI outcome', () => {
    // The base shipped a complete shell; the head lost it. Stated here rather
    // than carried by a factory default, because the movement is the assertion.
    const base = snapshot([route({
      shell: {
        predictedStatic: ['CoursePage'],
        predictedHoles: [],
        actual: { htmlPath: 'server/app/index.html', bytes: 2048, holes: 0, boundaryIds: [], shellRatio: 1 },
        agreement: 1,
        unknown: [],
      },
    })], 'base')
    const head = snapshot([route({
      renderingMode: 'DYNAMIC',
      renderingModeReason: 'uncached fetch at lib/data.ts:29',
      dynamicReasons: ['uncached fetch at lib/data.ts:29'],
      shell: {
        predictedStatic: [],
        predictedHoles: [{ component: 'CoursePage', boundary: '<route>', reason: 'uncached fetch at lib/data.ts:29' }],
        actual: null,
        agreement: null,
        unknown: [],
      },
    })], 'head')
    const diff = diffSnapshots(base, head)
    const output = renderSnapshotTerminal(head, {
      diff,
      breaches: [{ pattern: '/', kind: 'rendering-mode', message: 'became dynamic', blame: 'lib/data.ts:29' }],
    }, 76)

    expect(output).toContain('became dynamic')
    expect(output).toContain('Cause: uncached fetch at lib/data.ts:29')
    expect(output).toContain('Introduced by: <CoursePage>')
    expect(output).toContain('Shell: 100% → unavailable')
    expect(output).toContain('CI → fail (1 breach)')
  })

  it('groups causes above the route table and states attribution', () => {
    const routes = (deps: Record<string, number>, bytes: number) => [
      route({ id: 'app/cart/page.tsx', pattern: '/cart', dependencies: deps, firstLoadBytes: bytes }),
      route({ id: 'app/checkout/page.tsx', pattern: '/checkout', dependencies: deps, firstLoadBytes: bytes }),
    ]
    const output = renderDiffTerminal(
      diffSnapshots(snapshot(routes({}, 100_000), 'base'), snapshot(routes({ 'date-fns': 48_000 }, 148_000), 'head')),
      96,
    )

    // One cause, once, with the blast radius and its kind - above CHANGED ROUTES,
    // because the named cause is the decision and the byte column is not.
    expect(output).toContain('CAUSES')
    expect(output).toContain('date-fns')
    expect(output).toContain('package')
    expect(output).toContain('/cart, /checkout')
    expect(output).toContain('(2 routes)')
    expect(output.indexOf('CAUSES')).toBeLessThan(output.indexOf('CHANGED ROUTES'))
    expect(output).toContain('attribution 100%')
  })

  it('shows attribution as a movement when the comparison got weaker', () => {
    // The trust signal the verdict needs: same deltas, much weaker explanation.
    const strong = snapshot([route({ modules: { 'a.ts': 100_000 }, unattributedBytes: 0 })], 'base')
    const weak = snapshot(
      [route({ modules: { 'a.ts': 40_000 }, unattributedBytes: 60_000, firstLoadBytes: 120_000 })],
      'head',
    )

    expect(renderDiffTerminal(diffSnapshots(strong, weak), 96)).toContain('attribution 100% → 40%')
  })

  it('renders size movement and cause details for a diff', () => {
    const base = snapshot([route({ firstLoadBytes: 100_000 })], 'base')
    const head = snapshot([
      route({
        firstLoadBytes: 120_000,
        modules: { 'components/Hero.tsx': 20_000 },
      }),
    ], 'head')
    const output = renderDiffTerminal(diffSnapshots(base, head), 64)

    expect(output).toContain('CRUST / DIFF')
    expect(output).toContain('SIZE MOVEMENT')
    expect(output).toContain('+19.5 kB')
    expect(output).toContain('CHANGED ROUTES')
    // Stated once, in the lead, with the file and what to do about it. It used to
    // appear again under WHY IT MOVED, saying less.
    expect(output).toContain('CHANGES')
    expect(output).toContain('components/Hero.tsx')
    expect(output).toContain('next/dynamic')
    expect(output).not.toContain('WHY IT MOVED')
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(64)
  })

  it('leads every diff with the decision, then the changes behind it', () => {
    const base = snapshot([route({ firstLoadBytes: 100_000 })], 'base')
    const head = snapshot([route({ firstLoadBytes: 160_000, modules: { 'components/Hero.tsx': 60_000 } })], 'head')
    const output = renderDiffTerminal(diffSnapshots(base, head), 96)

    // The answer before the inventory: the sentence comes first, the route table
    // is below it.
    expect(output).toContain('DECISION')
    expect(output).toContain('1 route grew')
    expect(output.indexOf('DECISION')).toBeLessThan(output.indexOf('CHANGED ROUTES'))
    expect(output.indexOf('1 route grew')).toBeLessThan(output.indexOf('CHANGES'))
  })

  it('states a budget breach as the decision, the way ci would', () => {
    const base = snapshot([route({ firstLoadBytes: 100_000 })], 'base')
    const head = snapshot([route({ firstLoadBytes: 160_000 })], 'head')
    const output = renderDiffTerminal(diffSnapshots(base, head), {
      breaches: [{ pattern: '/', kind: 'first-load', message: 'first load 160 kB over the 120 kB ceiling', blame: null }],
    })

    // `diff` reads the same budget file `ci` does, so a local run cannot report
    // "1 route grew" for a pair CI will block.
    expect(output).toContain('BLOCK')
    expect(output).toContain('1 budget breach')
  })

  it('leads with an improvement when nothing regressed', () => {
    const base = snapshot([route({ firstLoadBytes: 200_000 })], 'base')
    const head = snapshot([route({ firstLoadBytes: 120_000 })], 'head')
    const output = renderDiffTerminal(diffSnapshots(base, head), 96)

    // A comparison that only reports failures cannot say whether a refactor
    // worked. "1 route changed" was the old sentence for this.
    expect(output).toContain('1 route improved, nothing regressed')
    expect(output).toContain('✓ /')
    expect(output).toContain('-78.1 kB')
  })
})

function snapshot(routes: RouteSnapshot[], buildId = 'build'): Snapshot {
  return base({
    toolVersion: 'test',
    buildId,
    createdAt: '2026-08-02T00:00:00.000Z',
    branch: null,
    nextVersion: '16.2.6',
    bundler: 'turbopack',
    sourceSignature: buildId,
    routes,
  })
}

