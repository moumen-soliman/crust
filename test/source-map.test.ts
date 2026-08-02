import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeChunkList, readSourceMap, resolveFirstParty } from '../src/analyze/source-map.ts'
import { createIndex } from '../src/core/workspace.ts'

const index = createIndex('/repo', ['app/page.tsx', 'components/Gallery.tsx', 'components/Counter.tsx', 'lib/http.ts'])

describe('resolveFirstParty', () => {
  it('resolves webpack project-relative sources', () => {
    expect(resolveFirstParty('webpack://_N_E/./components/Gallery.tsx', index)).toBe('components/Gallery.tsx')
  })

  it('resolves turbopack workspace-anchored sources', () => {
    expect(resolveFirstParty('turbopack:///[project]/code/crust/fixtures/basic/components/Gallery.tsx', index)).toBe(
      'components/Gallery.tsx',
    )
  })

  it("does not claim Next's own src/ as first-party", () => {
    // The regression that made the first spike report Next's router as app code:
    // these paths contain no `node_modules` segment.
    expect(resolveFirstParty('webpack://_N_E/../../../src/shared/lib/router/router.ts', index)).toBeNull()
    expect(resolveFirstParty('webpack://_N_E/../../src/client/components/app-router.tsx', index)).toBeNull()
  })

  it('rejects dependency sources', () => {
    expect(resolveFirstParty('webpack://_N_E/./node_modules/react/index.js', index)).toBeNull()
  })

  it('prefers the longest matching suffix', () => {
    // A bare `page.tsx` must not be claimed by `app/page.tsx`.
    expect(resolveFirstParty('webpack://_N_E/./some/other/page.tsx', index)).toBeNull()
    expect(resolveFirstParty('turbopack:///[project]/whatever/app/page.tsx', index)).toBe('app/page.tsx')
  })

  it('strips webpack query suffixes', () => {
    expect(resolveFirstParty('webpack://_N_E/./lib/http.ts?160d', index)).toBe('lib/http.ts')
  })
})

describe('normalizeChunkList', () => {
  it('drops webpack chunk ids and decodes dynamic segments', () => {
    expect(
      normalizeChunkList([
        '619',
        'static/chunks/619-8c42aac6727d22d1.js',
        '221',
        'static/chunks/app/products/%5Bslug%5D/page-a73ecfd0431c4de9.js',
      ]),
    ).toEqual([
      'static/chunks/619-8c42aac6727d22d1.js',
      'static/chunks/app/products/[slug]/page-a73ecfd0431c4de9.js',
    ])
  })

  it('strips the turbopack /_next/ prefix', () => {
    expect(normalizeChunkList(['/_next/static/chunks/0hvgj8skf9eh1.js'])).toEqual(['static/chunks/0hvgj8skf9eh1.js'])
  })
})

describe('readSourceMap', () => {
  it('follows sourceMappingURL when the map name differs from the chunk name', async () => {
    // Turbopack's actual behaviour: `chunk + '.map'` does not exist.
    const dir = await mkdtemp(join(tmpdir(), 'crust-'))
    const chunk = join(dir, '3cqmf8g-py4nf.js')
    await writeFile(join(dir, '3ixj0_2my9s3k.js.map'), '{"version":3,"sources":["a.ts"]}')
    const code = 'console.log(1)\n//# sourceMappingURL=3ixj0_2my9s3k.js.map'
    await writeFile(chunk, code)

    expect(await readSourceMap(chunk, code)).toContain('"sources":["a.ts"]')
  })

  it('falls back to the sibling map when the comment was stripped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-'))
    const chunk = join(dir, 'page.js')
    await writeFile(chunk, 'console.log(1)')
    await writeFile(chunk + '.map', '{"version":3,"sources":["b.ts"]}')

    expect(await readSourceMap(chunk, 'console.log(1)')).toContain('"sources":["b.ts"]')
  })

  it('returns null rather than throwing when there is no map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-'))
    const chunk = join(dir, 'polyfills.js')
    await writeFile(chunk, 'console.log(1)')

    expect(await readSourceMap(chunk, 'console.log(1)')).toBeNull()
  })

  it('decodes inline base64 maps', async () => {
    const payload = Buffer.from('{"version":3,"sources":["c.ts"]}').toString('base64')
    const code = `console.log(1)\n//# sourceMappingURL=data:application/json;base64,${payload}`
    expect(await readSourceMap('/nonexistent/chunk.js', code)).toContain('"sources":["c.ts"]')
  })
})
