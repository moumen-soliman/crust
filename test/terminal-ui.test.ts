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
    expect(output).toContain('WHY IT MOVED')
    expect(output).toContain('components/Hero.tsx')
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(64)
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

