import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedCausesFor } from '../src/analyze/blast.ts'
import { compareConfig, readBuildConfig } from '../src/analyze/config.ts'
import { buildModuleGraph, createResolver, type ModuleGraph } from '../src/analyze/module-graph.ts'
import { barrelCosts, boundaryCosts } from '../src/analyze/shape.ts'
import { createIndex } from '../src/core/workspace.ts'
import { route, snapshot } from './factories.ts'

async function graphOf(files: Record<string, string>, entry: string): Promise<ModuleGraph> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crust-blast-')))
  for (const [path, source] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, source, 'utf8')
  }
  return buildModuleGraph(join(root, entry), createIndex(root, Object.keys(files)), createResolver(null), {})
}

describe('barrel cost', () => {
  const FILES = {
    'ui/Gallery.tsx': `'use client'\nexport function Gallery() { return <div /> }`,
    'ui/Counter.tsx': `'use client'\nexport function Counter() { return <div /> }`,
    'ui/Hero.tsx': `export function Hero() { return <h1 /> }`,
    'ui/index.tsx': `export { Hero } from './Hero'\nexport { Gallery } from './Gallery'\nexport { Counter } from './Counter'`,
    'page.tsx': `
      import { Hero } from './ui/index'
      export default function Page() { return <Hero /> }
    `,
  }

  it('charges the barrel for what the route never renders', async () => {
    const graph = await graphOf(FILES, 'page.tsx')
    const [barrel] = barrelCosts(graph, 'page.tsx', {
      'ui/Hero.tsx': 100,
      'ui/Gallery.tsx': 900,
      'ui/Counter.tsx': 500,
    })

    expect(barrel?.file).toBe('ui/index.tsx')
    // Hero included: it only reaches the page through the barrel too. The point
    // is what deleting the barrel import would cost, not which name was written.
    expect(barrel?.dragged.sort()).toEqual(['ui/Counter.tsx', 'ui/Gallery.tsx', 'ui/Hero.tsx'])
    expect(barrel?.bytes).toBe(1500)
  })

  it('does not blame the barrel for a module the route imports directly', async () => {
    // Proven by re-walking with the barrel removed rather than assumed from the
    // import style, so a component reachable both ways is nobody's regression.
    const graph = await graphOf(
      { ...FILES, 'page.tsx': `
        import { Hero } from './ui/index'
        import { Gallery } from './ui/Gallery'
        export default function Page() { return <><Hero /><Gallery /></> }
      ` },
      'page.tsx',
    )
    const [barrel] = barrelCosts(graph, 'page.tsx', { 'ui/Gallery.tsx': 900, 'ui/Counter.tsx': 500 })

    expect(barrel?.dragged).not.toContain('ui/Gallery.tsx')
    expect(barrel?.dragged).toContain('ui/Counter.tsx')
  })

  it('reports nothing when a barrel brings in nothing extra', async () => {
    const graph = await graphOf(
      {
        'ui/Hero.tsx': `export function Hero() { return <h1 /> }`,
        'ui/index.tsx': `export { Hero } from './Hero'`,
        'page.tsx': `import { Hero } from './ui/index'\nexport default function Page() { return <Hero /> }`,
      },
      'page.tsx',
    )
    expect(barrelCosts(graph, 'page.tsx', {})).toEqual([])
  })
})

describe('client boundary cost', () => {
  it('charges a boundary for its whole subtree, not just its own file', async () => {
    const graph = await graphOf(
      {
        'ui/heavy.tsx': `export const rows = Array.from({ length: 10 })`,
        'ui/Chart.tsx': `'use client'\nimport { rows } from './heavy'\nexport function Chart() { return <div>{rows.length}</div> }`,
        'page.tsx': `import { Chart } from './ui/Chart'\nexport default function Page() { return <Chart /> }`,
      },
      'page.tsx',
    )
    const [boundary] = boundaryCosts(graph, { 'ui/Chart.tsx': 300, 'ui/heavy.tsx': 2000 })

    expect(boundary?.file).toBe('ui/Chart.tsx')
    // Named from the sole declared component: shared UI rarely has a default export.
    expect(boundary?.component).toBe('Chart')
    expect(boundary?.bytes).toBe(2300)
  })
})

describe('shared causes', () => {
  const shared = (patterns: string[]) =>
    patterns.map((pattern) =>
      route({
        id: `app${pattern}/page.tsx`,
        pattern,
        layouts: ['app/layout.tsx'],
        clientBoundaries: [{ file: 'packages/ui/src/Provider.tsx', component: 'RootProvider', bytes: 86_016 }],
        modules: { 'packages/ui/src/Provider.tsx': 86_016 },
      }),
    )

  it('reports one root cause with every route it reaches', async () => {
    const causes = sharedCausesFor(shared(['/', '/a', '/b']), {
      packageNames: { 'packages/ui': '@repo/ui' },
    })
    const boundary = causes.find((cause) => cause.kind === 'client-boundary')

    expect(boundary?.label).toBe('<RootProvider>')
    expect(boundary?.routes).toEqual(['/', '/a', '/b'])
    expect(boundary?.bytesPerRoute).toBe(86_016)
    expect(boundary?.introducedBy).toBe('@repo/ui')
  })

  it('says nothing about a cause that touches only one route', async () => {
    // Otherwise every route's own components arrive as "shared" findings and the
    // section becomes a second route table.
    expect(sharedCausesFor(shared(['/']))).toEqual([])
  })

  it('takes the weakest evidence when a shared call site is unresolved on any route', async () => {
    const chain = (evidence: 'verified' | 'unknown') => ({
      route: '/x',
      entryFile: 'app/x/page.tsx',
      component: 'Page',
      links: [],
      site: 'lib/http.ts:3',
      detail: 'uncached fetch',
      evidence,
      unresolved: evidence === 'unknown' ? 'namespace import' : null,
    })

    const causes = sharedCausesFor([
      route({ id: 'a', pattern: '/a', causes: [chain('verified')] }),
      route({ id: 'b', pattern: '/b', causes: [chain('unknown')] }),
    ])
    const site = causes.find((cause) => cause.kind === 'call-site')

    expect(site?.routes).toEqual(['/a', '/b'])
    expect(site?.evidence).toBe('unknown')
  })

  it('excludes route handlers, which have no client bundle to share', async () => {
    const causes = sharedCausesFor([
      ...shared(['/a']),
      route({ id: 'api', pattern: '/api/x', renderingMode: 'ROUTE_HANDLER' }),
    ])
    expect(causes).toEqual([])
  })
})

describe('configuration changes', () => {
  const withConfig = (over: Partial<ReturnType<typeof readBuildConfig>>, rest: Parameters<typeof snapshot>[0] = {}) =>
    snapshot({ config: { cacheComponents: false, experimental: {}, sourceMaps: true, ...over }, ...rest })

  it('explains a Cache Components switch instead of blaming the routes it moved', () => {
    const [change] = compareConfig(withConfig({}), withConfig({ cacheComponents: true }))

    expect(change?.key).toBe('cacheComponents')
    expect(change?.summary).toBe('Cache Components turned on')
    expect(change?.explains).toContain('rendering is now opt-in')
    expect(change?.incomparable).toBe(true)
  })

  it('flags losing source maps, which empties module lists without deleting code', () => {
    const [change] = compareConfig(withConfig({}), withConfig({ sourceMaps: false }))

    expect(change?.key).toBe('productionBrowserSourceMaps')
    expect(change?.explains).toContain('per-file attribution is gone')
    // Real, but the two builds are still comparable on everything else.
    expect(change?.incomparable).toBe(false)
  })

  it('names a deliberate route segment config change', () => {
    const before = snapshot({ routes: [route({ config: {} })] })
    const after = snapshot({ routes: [route({ config: { dynamic: 'force-dynamic' } })] })

    const change = compareConfig(before, after).find((c) => c.key.includes('dynamic'))
    expect(change?.summary).toBe('/: dynamic changed: unset -> force-dynamic')
    expect(change?.explains).toContain('deliberately')
  })

  it('says nothing when the build did not change', () => {
    expect(compareConfig(withConfig({}), withConfig({}))).toEqual([])
  })

  it('reads only the experimental flags that change emitted output', () => {
    const config = readBuildConfig({
      resolved: { experimental: { ppr: true, someInternalKnob: 'x', optimizePackageImports: ['a'] } },
      sourceMaps: true,
    })

    expect(config.experimental).toEqual({ ppr: true, optimizePackageImports: true })
  })
})
