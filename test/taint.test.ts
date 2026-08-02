import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModuleGraph, createResolver, propagateDynamicTaint } from '../src/analyze/module-graph.ts'
import { createIndex } from '../src/core/workspace.ts'

/**
 * These write real files because the taint graph is a resolver-driven walk over
 * real specifiers; a hand-built graph would test the propagation loop while
 * skipping the part that has actually been wrong.
 */
async function taintOf(files: Record<string, string>, entry: string): Promise<string[]> {
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
  const graph = await buildModuleGraph(join(root, entry), index, createResolver(null), {})
  return propagateDynamicTaint(graph).get(entry) ?? []
}

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
    // time, so this module is a mistake — but containment must not be what hides
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
    // — because taint stopped merging into a module that already had its own —
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
