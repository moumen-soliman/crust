import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBytesCause, buildCauseChain, causeChainLines, importPathTo } from '../src/analyze/cause.ts'
import {
  baseReason,
  buildModuleGraph,
  createResolver,
  propagateDynamicTaint,
  reachableTaint,
  type ModuleGraph,
} from '../src/analyze/module-graph.ts'
import { createIndex } from '../src/core/workspace.ts'
import type { CauseChain } from '../src/store/snapshot.ts'

async function graphOf(files: Record<string, string>, entry: string): Promise<ModuleGraph> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crust-cause-')))
  for (const [path, source] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, source, 'utf8')
  }
  const index = createIndex(root, Object.keys(files))
  return buildModuleGraph(join(root, entry), index, createResolver(null), {})
}

/** Every dynamic-rendering chain a route entry produces, in walk order. */
async function chainsFor(files: Record<string, string>, entry: string, route = '/'): Promise<CauseChain[]> {
  const graph = await graphOf(files, entry)
  const taint = propagateDynamicTaint(graph)
  const reach = reachableTaint(graph, [entry])

  return (taint.get(entry) ?? [])
    .filter((reason) => reach.reachable.has(baseReason(reason)))
    .map((reason) =>
      buildCauseChain({
        route,
        graph,
        entryFile: entry,
        reason,
        path: reach.reachable.get(baseReason(reason))!,
        confirmedByArtifact: true,
      }),
    )
}

describe('cause chains', () => {
  it('carries binding names from the route entry to the call site', async () => {
    const [chain] = await chainsFor(
      {
        'lib/http.tsx': `
          export async function fetchJson(url) {
            return (await fetch(url, { cache: 'no-store' })).json()
          }
        `,
        'lib/product.tsx': `
          import { fetchJson } from './http'
          export async function getProduct(slug) { return fetchJson('https://example.invalid/' + slug) }
        `,
        'page.tsx': `
          import { getProduct } from './lib/product'
          export default async function ProductPage() {
            return <div>{(await getProduct('a')).name}</div>
          }
        `,
      },
      'page.tsx',
      '/products/[slug]',
    )

    expect(chain?.component).toBe('ProductPage')
    expect(chain?.site).toBe('lib/http.tsx:3')
    expect(chain?.detail).toBe('uncached fetch')
    expect(chain?.evidence).toBe('verified')
    expect(chain?.unresolved).toBeNull()
    expect(chain?.links.map((link) => `${link.binding}@${link.file}`)).toEqual([
      'ProductPage@page.tsx',
      'getProduct@lib/product.tsx',
      'fetchJson@lib/http.tsx',
    ])
  })

  it('renders the chain in the documented arrow form', async () => {
    const [chain] = await chainsFor(
      {
        'lib/session.tsx': `
          import { cookies } from 'next/headers'
          export async function readSession() { return (await cookies()).get('sid') }
        `,
        'page.tsx': `
          import { readSession } from './lib/session'
          export default async function Dashboard() { return <div>{await readSession()}</div> }
        `,
      },
      'page.tsx',
      '/dashboard',
    )

    expect(causeChainLines(chain!)).toEqual([
      '/dashboard',
      '<Dashboard>',
      'readSession · lib/session.tsx',
      'cookies() at lib/session.tsx:3',
    ])
  })

  it('names the barrel a chain passes through', async () => {
    const [chain] = await chainsFor(
      {
        'ui/Chart.tsx': `
          import { cookies } from 'next/headers'
          export async function Chart() { return <div>{(await cookies()).get('t')?.value}</div> }
        `,
        'ui/index.tsx': `export { Chart } from './Chart'`,
        'page.tsx': `
          import { Chart } from './ui/index'
          export default function Page() { return <Chart /> }
        `,
      },
      'page.tsx',
    )

    const barrel = chain?.links.find((link) => link.barrel)
    expect(barrel?.file).toBe('ui/index.tsx')
    expect(causeChainLines(chain!)).toContain('barrel import ui/index.tsx')
  })

  it('reports the unresolved segment instead of inventing the rest of the chain', async () => {
    const [chain] = await chainsFor(
      {
        'lib/services.tsx': `
          export async function live() {
            return (await fetch('https://example.invalid', { cache: 'no-store' })).json()
          }
        `,
        'page.tsx': `
          import * as services from './lib/services'
          export default async function Page() { return <div>{await services.live()}</div> }
        `,
      },
      'page.tsx',
    )

    expect(chain?.evidence).toBe('unknown')
    expect(chain?.unresolved).toContain('namespace')
    expect(causeChainLines(chain!).some((line) => line.startsWith('unresolved:'))).toBe(true)
  })
})

describe('client JavaScript chains', () => {
  const FILES = {
    'ui/Heavy.tsx': `'use client'\nexport function Heavy() { return <div /> }`,
    'ui/index.tsx': `export { Heavy } from './Heavy'`,
    'page.tsx': `
      import { Heavy } from './ui/index'
      export default function PackagePage() { return <Heavy /> }
    `,
  }

  it('follows import edges to the module that costs the bytes', async () => {
    const graph = await graphOf(FILES, 'page.tsx')
    const links = importPathTo(graph, 'page.tsx', 'ui/Heavy.tsx')

    expect(links?.map((link) => link.file)).toEqual(['ui/index.tsx', 'ui/Heavy.tsx'])
    expect(links?.[0]?.barrel).toBe(true)
  })

  it('blames the barrel when one is on the path', async () => {
    const graph = await graphOf(FILES, 'page.tsx')
    const cause = buildBytesCause({
      route: '/packages',
      graph,
      entryFile: 'page.tsx',
      file: 'ui/Heavy.tsx',
      bytes: 226_304,
    })

    expect(cause.detail).toBe('221.0 kB through barrel import ui/index.tsx')
    expect(cause.evidence).toBe('verified')
    expect(cause.site).toBe('ui/Heavy.tsx')
  })

  it('says so when no import path explains the bytes', async () => {
    const graph = await graphOf(FILES, 'page.tsx')
    const cause = buildBytesCause({
      route: '/packages',
      graph,
      entryFile: 'page.tsx',
      file: 'somewhere/else.tsx',
      bytes: 1024,
    })

    expect(cause.evidence).toBe('unknown')
    expect(cause.unresolved).toContain('no import path')
    expect(cause.links).toEqual([])
  })
})
