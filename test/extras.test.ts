import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treemapLayout, renderSparklineSvg, renderTreemapSvg } from '../src/report/viz.ts'
import { renderReportBody, renderReportStyles } from '../src/report/render.ts'
import { diffSnapshots } from '../src/diff/diff.ts'
import { SnapshotStore } from '../src/store/store.ts'
import { createIngestHandler } from '../src/ingest/handler.ts'
import { CrustSpanAggregator } from '../src/otel/spans.ts'
import { route, snapshot as base } from './factories.ts'
import type { RouteSnapshot, Snapshot } from '../src/store/snapshot.ts'


function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return base({
    toolVersion: 'test',
    buildId: Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}

describe('treemapLayout', () => {
  it('tiles the full area', () => {
    const cells = treemapLayout(
      [
        { label: 'a', value: 6 },
        { label: 'b', value: 3 },
        { label: 'c', value: 1 },
      ],
      100,
      100,
    )
    const area = cells.reduce((sum, cell) => sum + cell.w * cell.h, 0)
    expect(area).toBeCloseTo(100 * 100, 0)
  })

  it('keeps every cell inside the bounds', () => {
    const cells = treemapLayout(
      Array.from({ length: 12 }, (_, i) => ({ label: `m${i}`, value: (i + 1) * 7 })),
      720,
      220,
    )
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(-0.01)
      expect(cell.y).toBeGreaterThanOrEqual(-0.01)
      expect(cell.x + cell.w).toBeLessThanOrEqual(720.01)
      expect(cell.y + cell.h).toBeLessThanOrEqual(220.01)
    }
  })

  it('returns nothing for empty or zero-valued input', () => {
    expect(treemapLayout([], 100, 100)).toEqual([])
    expect(treemapLayout([{ label: 'a', value: 0 }], 100, 100)).toEqual([])
  })

  it('labels every tile and maps size onto the OKLCH color ramp', () => {
    const svg = renderTreemapSvg(
      [
        { label: 'packages/ui/src/Large.tsx', value: 100_000 },
        { label: 'packages/ui/src/Tiny.tsx', value: 100 },
      ],
      180,
      70,
    )

    expect(svg).toContain('oklch(')
    expect(svg).toContain('--tm-size:1.000')
    expect(svg).toContain('--tm-size:0.000')
    expect(svg).toContain('aria-label="packages/ui/src/Large.tsx — 97.7 kB"')
    expect(svg).toContain('aria-label="packages/ui/src/Tiny.tsx — 0.1 kB"')
    expect(svg.match(/class="tm-label(?: tm-index)?"/g)).toHaveLength(2)
  })

  it('includes the largest contributors and unattributed bytes in bundle composition', () => {
    const modules = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`src/m${index}.ts`, 1_000 - index]))
    const body = renderReportBody(
      snapshot({
        routes: [route({ modules, dependencies: { giant: 50_000 }, unattributedBytes: 20_000 })],
      }),
    )

    expect(body).toContain('giant — 48.8 kB')
    expect(body).toContain('(unattributed) — 19.5 kB')
    expect(body).toContain('smaller <i aria-hidden="true"></i> larger')
  })

  it('keeps bundle composition discoverable under every attributed route', () => {
    const body = renderReportBody(
      snapshot({ routes: [route({ modules: { 'src/only.ts': 12_000 } })] }),
    )

    expect(body).toContain('Open any route to inspect its cause chains, shell exits, and bundle composition.')
    expect(body).toContain('<span class="disclosure" aria-hidden="true">›</span>')
    expect(body).toContain('<b>Bundle composition</b>')
    expect(body).toContain('src/only.ts — 11.7 kB')
  })
})

describe('renderSparklineSvg', () => {
  it('needs at least two points', () => {
    expect(renderSparklineSvg([100])).toBe('')
    expect(renderSparklineSvg([100, 120])).toContain('<svg')
  })

  it('colors a growth trend as bad', () => {
    expect(renderSparklineSvg([100, 100, 150])).toContain('var(--red)')
    expect(renderSparklineSvg([150, 150, 100])).toContain('var(--green)')
    expect(renderSparklineSvg([100, 100, 100])).toContain('var(--faint)')
  })

  // The stroke names used to be `--bad` / `--static` / `--dim`, which the
  // stylesheet has never defined: `stroke` was invalid at computed-value time
  // and every sparkline in the report drew nothing but its end dot. Asserting
  // the names exist stops the pair drifting apart again.
  it('only names custom properties the report stylesheet defines', () => {
    const styles = renderReportStyles()
    const used = [...renderSparklineSvg([100, 100, 150]).matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]!)

    expect(used.length).toBeGreaterThan(0)
    for (const name of new Set(used)) expect(styles).toContain(`${name}:`)
  })
})

describe('route aliases in diff', () => {
  it('stitches a renamed route back onto its history', () => {
    const base = snapshot({ routes: [route({ id: 'app/old/page.tsx', pattern: '/old' })] })
    const head = snapshot({ routes: [route({ id: 'app/new/page.tsx', pattern: '/new', firstLoadBytes: 120_000 })] })

    const withoutAlias = diffSnapshots(base, head)
    expect(withoutAlias.routes.map((r) => r.status).sort()).toEqual(['added', 'removed'])

    const withAlias = diffSnapshots(base, head, { 'app/old/page.tsx': 'app/new/page.tsx' })
    expect(withAlias.routes).toHaveLength(1)
    expect(withAlias.routes[0]).toMatchObject({ status: 'changed', firstLoadDelta: 20_000 })
  })
})

describe('retention ladder', () => {
  it('keeps 50 full, collapses per-sha, thins beyond 90 days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-store-'))
    const store = new SnapshotStore(dir)
    const now = new Date('2026-08-01T00:00:00Z')

    // 55 snapshots: the newest 50 kept; among the older 5, two share a SHA
    // (one dropped) and two are past the 90-day line (thinned).
    for (let i = 0; i < 55; i++) {
      const age = i * 3 // days
      const at = new Date(now.getTime() - age * 86_400_000).toISOString()
      await store.write(
        snapshot({
          buildId: `b${String(i).padStart(15, '0')}`,
          gitSha: i === 51 ? 'shared-sha' : i === 52 ? 'shared-sha' : `sha-${i}`,
          committedAt: at,
          routes: [route({ modules: { 'lib/a.ts': 1000 } })],
        }),
      )
    }

    const result = await store.prune({ now })
    expect(result.dropped).toBe(1)
    expect(result.kept + result.thinned + result.dropped).toBe(55)

    // Thinned snapshots keep route totals but lose module detail.
    const all = await store.list()
    expect(all).toHaveLength(54)
    const thinned = all.filter((s) => Object.keys(s.routes[0]?.modules ?? {}).length === 0)
    expect(thinned.length).toBe(result.thinned)
    for (const s of thinned) expect(s.routes[0]?.firstLoadBytes).toBe(100_000)
  })
})

describe('ingest handler', () => {
  const handler = createIngestHandler({ secret: 'a-very-long-secret-string', dir: join(tmpdir(), 'crust-ingest-test') })

  const post = (body: string, token = 'a-very-long-secret-string') =>
    handler(
      new Request('http://staging/api/__crust/ingest', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
    )

  it('accepts an authenticated JSON payload', async () => {
    expect((await post('{"route":"/x"}')).status).toBe(204)
  })

  it('rejects a wrong token without leaking anything', async () => {
    const response = await post('{"route":"/x"}', 'wrong-token')
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('')
  })

  it('rejects non-JSON and oversized payloads', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post('x'.repeat(64 * 1024))).status).toBe(413)
  })

  it('refuses GET - write-only', async () => {
    const response = await handler(new Request('http://staging/api/__crust/ingest', { method: 'GET' }))
    expect(response.status).toBe(405)
  })

  it('refuses a short secret at construction', () => {
    expect(() => createIngestHandler({ secret: 'short' })).toThrow(/16 characters/)
  })
})

describe('CrustSpanAggregator', () => {
  it('groups render and fetch spans by route', () => {
    const aggregator = new CrustSpanAggregator()
    aggregator.onEnd({
      name: 'render route (app) /products/[slug]',
      startTime: [0, 0],
      endTime: [0, 120e6],
      attributes: { 'next.route': '/products/[slug]' },
    })
    aggregator.onEnd({
      name: 'fetch GET https://api.example.com/products',
      startTime: [0, 0],
      endTime: [0, 80e6],
      attributes: { 'next.route': '/products/[slug]', 'next.span_type': 'AppRender.fetch', 'http.url': 'https://api.example.com/products' },
    })

    const stats = aggregator.stats()
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({ route: '/products/[slug]', count: 1 })
    expect(stats[0]?.totalMs).toBeCloseTo(120, 0)
    expect(stats[0]?.fetches['api.example.com']?.totalMs).toBeCloseTo(80, 0)
  })

  it('ignores spans with no route attribute', () => {
    const aggregator = new CrustSpanAggregator()
    aggregator.onEnd({ name: 'gc', startTime: [0, 0], endTime: [0, 1e6], attributes: {} })
    expect(aggregator.stats()).toEqual([])
  })
})
