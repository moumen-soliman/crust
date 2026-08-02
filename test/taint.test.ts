import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  baseReason,
  buildModuleGraph,
  createResolver,
  propagateDynamicTaint,
  reachableTaint,
  type ModuleGraph,
} from '../src/analyze/module-graph.ts'
import { createIndex } from '../src/core/workspace.ts'

/**
 * These write real files because the taint graph is a resolver-driven walk over
 * real specifiers; a hand-built graph would test the propagation loop while
 * skipping the part that has actually been wrong.
 */
async function graphOf(files: Record<string, string>, entry: string): Promise<ModuleGraph> {
  // realpath, because macOS hands out `/var/…` temp dirs that are symlinks to
  // `/private/var/…`. The resolver returns the real path, the index is keyed on
  // the symlinked one, and every module edge is silently dropped.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crust-taint-')))
  for (const [path, source] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, source, 'utf8')
  }

  const index = createIndex(root, Object.keys(files))
  return buildModuleGraph(join(root, entry), index, createResolver(null), {})
}

async function taintOf(files: Record<string, string>, entry: string): Promise<string[]> {
  return propagateDynamicTaint(await graphOf(files, entry)).get(entry) ?? []
}

/** Module-level taint, then the per-export narrowing applied on top of it. */
async function narrowedTaintOf(files: Record<string, string>, entry: string) {
  const graph = await graphOf(files, entry)
  const moduleLevel = propagateDynamicTaint(graph).get(entry) ?? []
  const reach = reachableTaint(graph, [entry])
  return {
    moduleLevel,
    narrowed: moduleLevel.filter((reason) => reach.reachable.has(baseReason(reason))),
    conservative: reach.conservative,
  }
}

const SERVICES = `
  export async function cachedProduct(slug) {
    'use cache'
    return { slug }
  }
  export async function liveProduct(slug) {
    return (await fetch('https://example.invalid/' + slug, { cache: 'no-store' })).json()
  }
`

const UNCACHED_HELPER = `
export async function fetchJson(url) {
  return (await fetch(url, { cache: 'no-store' })).json()
}
`

describe('taint containment through `use cache`', () => {
  it('stops at a module whose every export is cached', async () => {
    // The shape this exists for: an uncached helper, wrapped one file up by a
    // cached function. Everything the page can reach goes through the cache, so
    // the page is not dynamic. Before this rule the page was reported dynamic and
    // the emitted shell disagreed.
    const reasons = await taintOf(
      {
        'lib/http.tsx': UNCACHED_HELPER,
        'lib/product.tsx': `
          import { fetchJson } from './http'
          export async function getProduct(slug) {
            'use cache'
            return fetchJson('https://example.invalid/' + slug)
          }
        `,
        'page.tsx': `
          import { getProduct } from './lib/product'
          export default async function Page() { return <div>{(await getProduct('a')).name}</div> }
        `,
      },
      'page.tsx',
    )

    expect(reasons).toEqual([])
  })

  it('still propagates when one export is left uncached', async () => {
    // Module granularity cannot tell which export the importer called, so a
    // single uncached export has to keep the taint flowing. Erring the other way
    // would report a genuinely dynamic route as static.
    const reasons = await taintOf(
      {
        'lib/http.tsx': UNCACHED_HELPER,
        'lib/product.tsx': `
          import { fetchJson } from './http'
          export async function getProduct(slug) {
            'use cache'
            return fetchJson('https://example.invalid/' + slug)
          }
          export async function getLive(slug) {
            return fetchJson('https://example.invalid/live/' + slug)
          }
        `,
        'page.tsx': `
          import { getProduct } from './lib/product'
          export default async function Page() { return <div>{(await getProduct('a')).name}</div> }
        `,
      },
      'page.tsx',
    )

    expect(reasons.join(' ')).toContain('uncached fetch at lib/http.tsx')
  })

  it('does not contain a module that re-exports a namespace', async () => {
    // `export *` exports names this file cannot enumerate, so "every export is
    // cached" is unknowable rather than true.
    const reasons = await taintOf(
      {
        'lib/http.tsx': UNCACHED_HELPER,
        'lib/product.tsx': `
          export * from './http'
          export async function getProduct(slug) {
            'use cache'
            return null
          }
        `,
        'page.tsx': `
          import { getProduct } from './lib/product'
          export default async function Page() { return <div>{await getProduct('a')}</div> }
        `,
      },
      'page.tsx',
    )

    expect(reasons.join(' ')).toContain('uncached fetch at lib/http.tsx')
  })

  it('does not let a cached wrapper hide a dynamic API from the route', async () => {
    // `cookies()` is not cacheable. Next rejects it inside `use cache` at build
    // time, so this module is a mistake - but containment must not be what hides
    // it, or a stray directive silently turns "this route reads request state"
    // into "this route is static". Every export here is cached, which is exactly
    // the condition that contains an uncached fetch; the dynamic API must escape
    // anyway.
    const reasons = await taintOf(
      {
        'lib/session.tsx': `
          import { cookies } from 'next/headers'
          export async function readSession() {
            'use cache'
            return (await cookies()).get('sid')
          }
        `,
        'page.tsx': `
          import { readSession } from './lib/session'
          export default async function Page() { return <div>{await readSession()}</div> }
        `,
      },
      'page.tsx',
    )

    expect(reasons.join(' ')).toContain('cookies() at lib/session.tsx')
  })

  it('contains the fetch and lets the dynamic API through from the same module', async () => {
    // Both kinds of taint reaching one contained module, to pin that the filter
    // is by kind rather than all-or-nothing in either direction.
    //
    // The uncached fetch has to *arrive* at `lib/mixed.tsx` from `lib/http.tsx`
    // for containment to be what stops it. If the reason never reached the module
    // - because taint stopped merging into a module that already had its own -
    // this assertion would pass without the filter ever running.
    const files = {
      'lib/http.tsx': UNCACHED_HELPER,
      'lib/mixed.tsx': `
          import { cookies } from 'next/headers'
          import { fetchJson } from './http'
          export async function load() {
            'use cache'
            return [await fetchJson('x'), (await cookies()).get('sid')]
          }
        `,
      'page.tsx': `
          import { load } from './lib/mixed'
          export default async function Page() { return <div>{await load()}</div> }
        `,
    }

    expect((await taintOf(files, 'lib/mixed.tsx')).join(' ')).toContain('uncached fetch at lib/http.tsx')

    const reasons = await taintOf(files, 'page.tsx')
    expect(reasons.join(' ')).toContain('cookies() at lib/mixed.tsx')
    expect(reasons.join(' ')).not.toContain('uncached fetch')
  })

  it('keeps both reasons when a module has its own taint and inherits more', async () => {
    // First-writer-wins used to discard the inherited reason outright, so fixing
    // the one crust named left the route dynamic for a reason it never mentioned.
    const reasons = await taintOf(
      {
        'lib/http.tsx': UNCACHED_HELPER,
        'lib/both.tsx': `
          import { cookies } from 'next/headers'
          import { fetchJson } from './http'
          export async function readSession() { return (await cookies()).get('sid') }
          export async function load() { return fetchJson('x') }
        `,
        'page.tsx': `
          import { load, readSession } from './lib/both'
          export default async function Page() { return <div>{await load()}{await readSession()}</div> }
        `,
      },
      'page.tsx',
    )

    expect(reasons.join(' ')).toContain('cookies() at lib/both.tsx')
    expect(reasons.join(' ')).toContain('uncached fetch at lib/http.tsx')
  })
})

describe('per-export taint narrowing', () => {
  it('does not blame a sibling export the route never references', async () => {
    // The motivating case. Module granularity taints the page through
    // `liveProduct` purely because it shares a file with the function the page
    // actually calls.
    const { moduleLevel, narrowed, conservative } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'page.tsx': `
          import { cachedProduct } from './lib/services'
          export default async function Page() { return <div>{(await cachedProduct('a')).slug}</div> }
        `,
      },
      'page.tsx',
    )

    expect(moduleLevel.join(' ')).toContain('uncached fetch at lib/services.tsx')
    expect(narrowed).toEqual([])
    expect(conservative).toEqual([])
  })

  it('keeps the reason when the route does reference that export', async () => {
    const { narrowed } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'page.tsx': `
          import { liveProduct } from './lib/services'
          export default async function Page() { return <div>{(await liveProduct('a')).slug}</div> }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('uncached fetch at lib/services.tsx')
  })

  it('follows a binding handed to another function rather than called', async () => {
    // `withRetry(liveProduct)` reaches liveProduct with no call expression on it.
    // A call-edge graph drops this; narrowing on references does not.
    const { narrowed } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'lib/retry.tsx': `export function withRetry(fn) { return fn }`,
        'page.tsx': `
          import { liveProduct } from './lib/services'
          import { withRetry } from './lib/retry'
          export default async function Page() {
            const load = withRetry(liveProduct)
            return <div>{(await load('a')).slug}</div>
          }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('uncached fetch at lib/services.tsx')
  })

  it('follows the chain through a barrel re-export', async () => {
    const { narrowed } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'lib/index.tsx': `export { cachedProduct, liveProduct } from './services'`,
        'page.tsx': `
          import { liveProduct } from './lib/index'
          export default async function Page() { return <div>{(await liveProduct('a')).slug}</div> }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('uncached fetch at lib/services.tsx')
  })

  it('narrows through a barrel when only the cached export is taken', async () => {
    const { moduleLevel, narrowed } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'lib/index.tsx': `export { cachedProduct, liveProduct } from './services'`,
        'page.tsx': `
          import { cachedProduct } from './lib/index'
          export default async function Page() { return <div>{(await cachedProduct('a')).slug}</div> }
        `,
      },
      'page.tsx',
    )

    expect(moduleLevel.join(' ')).toContain('uncached fetch')
    expect(narrowed).toEqual([])
  })

  it('falls back to the module-level answer for a namespace import', async () => {
    // Which member `services.x` reads is not knowable from the import, so the
    // whole module has to count - and the fallback is declared, not silent.
    const { narrowed, conservative } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'page.tsx': `
          import * as services from './lib/services'
          export default async function Page() { return <div>{(await services.cachedProduct('a')).slug}</div> }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('uncached fetch at lib/services.tsx')
    expect(conservative).toContain('lib/services.tsx')
  })

  it('falls back when a call target is computed', async () => {
    const { narrowed, conservative } = await narrowedTaintOf(
      {
        'lib/services.tsx': SERVICES,
        'page.tsx': `
          import { cachedProduct } from './lib/services'
          export default async function Page({ params }) {
            const table = { cachedProduct }
            return <div>{(await table[params.mode]('a')).slug}</div>
          }
        `,
      },
      'page.tsx',
    )

    expect(conservative).toContain('page.tsx')
    expect(narrowed.join(' ')).toContain('uncached fetch at lib/services.tsx')
  })

  it('never narrows away work that runs at module scope', async () => {
    // Import-time code runs for every importer whatever export they asked for.
    const { narrowed } = await narrowedTaintOf(
      {
        'lib/boot.tsx': `
          import { cookies } from 'next/headers'
          export const sid = cookies().get('sid')
          export function unrelated() { return 1 }
        `,
        'page.tsx': `
          import { unrelated } from './lib/boot'
          export default function Page() { return <div>{unrelated()}</div> }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('cookies() at lib/boot.tsx')
  })

  it('counts exports other than default as entry points', async () => {
    // `generateMetadata` runs for the same request and makes the same route
    // dynamic, so seeding only the default export would miss it.
    const { narrowed } = await narrowedTaintOf(
      {
        'page.tsx': `
          import { cookies } from 'next/headers'
          export async function generateMetadata() {
            return { title: (await cookies()).get('t')?.value }
          }
          export default function Page() { return <div>hi</div> }
        `,
      },
      'page.tsx',
    )

    expect(narrowed.join(' ')).toContain('cookies() at page.tsx')
  })
})
