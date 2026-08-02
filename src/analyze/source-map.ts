import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectFileIndex } from '../core/workspace.ts'

/**
 * Locating a chunk's source map.
 *
 * webpack writes `chunk.js` next to `chunk.js.map`. Turbopack does not - it names
 * maps independently (`3cqmf8g-py4nf.js` -> `3ixj0_2my9s3k.js.map`), so the
 * sibling guess finds nothing there. Measured cost of getting this wrong:
 * Turbopack attribution reads 17.5% instead of 99.8% (docs/phase-0-findings.md).
 *
 * The `sourceMappingURL` comment is the only correct link. The sibling guess
 * survives only as a fallback for maps whose comment was stripped.
 */
export async function readSourceMap(chunkPath: string, code: string): Promise<string | null> {
  const match = /[#@]\s*sourceMappingURL=(\S+)/.exec(code)
  const url = match?.[1]

  if (url?.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma === -1) return null
    const payload = url.slice(comma + 1)
    return url.slice(0, comma).includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload)
  }

  if (url) {
    try {
      return await readFile(join(chunkPath, '..', decodeURIComponent(url)), 'utf8')
    } catch {
      // Comment present but the file is missing - fall through to the sibling guess.
    }
  }

  try {
    return await readFile(chunkPath + '.map', 'utf8')
  } catch {
    return null
  }
}

/**
 * Map a source-map source URL back to a file in the project, or null if it isn't
 * the project's own code.
 *
 * Why this isn't a prefix or `node_modules` check: Next ships source maps that
 * point into its **own** `src/`, so `!src.includes('node_modules')` reports
 * Next's router and segment cache as the user's application code. The bundlers
 * also disagree on anchoring - webpack emits `webpack://_N_E/./components/x.tsx`
 * while Turbopack emits `turbopack:///[project]/<workspace-relative>/x.tsx`,
 * where `[project]` is the inferred workspace root, not the app directory.
 *
 * Existence in the project is the only test that survives both.
 *
 * Matching has to work in *both* directions. The source path can be shorter than
 * the index entry (webpack's `./components/Gallery.tsx` against a monorepo-rooted
 * `apps/web/components/Gallery.tsx`) or longer (Turbopack's absolute
 * `[project]/…/fixtures/basic/components/Gallery.tsx`). A one-directional lookup
 * silently resolves nothing in exactly the monorepo case that matters most.
 *
 * Ambiguity resolves to null, never to a guess: two files sharing a basename with
 * equally good suffixes cannot be told apart, and picking one would attribute
 * bytes to the wrong file.
 */
export function resolveFirstParty(sourceUrl: string, index: ProjectFileIndex): string | null {
  const stripped = sourceUrl
    .replace(/^[a-z-]+:\/\/[^/]*\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^\.\//, '')
    .replace(/\?[0-9a-f]+$/, '')
    .replace(/ <module evaluation>$/, '')

  if (stripped.includes('node_modules')) return null
  if (index.files.has(stripped)) return stripped

  const basename = stripped.slice(stripped.lastIndexOf('/') + 1)
  const candidates = index.byBasename.get(basename)
  if (!candidates || candidates.length === 0) return null

  let best: string | null = null
  let bestScore = 0
  let tied = false

  for (const candidate of candidates) {
    const score = sharedSuffixSegments(stripped, candidate)
    // A shared basename is not a match. One path must be a genuine suffix of the
    // other, or `some/other/page.tsx` would be attributed to `app/page.tsx`.
    if (score < Math.min(segmentCount(stripped), segmentCount(candidate))) continue
    if (score > bestScore) {
      best = candidate
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }

  return tied ? null : best
}

const segmentCount = (p: string): number => p.split('/').length

/** Number of trailing path segments two paths agree on. */
function sharedSuffixSegments(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  let shared = 0
  while (shared < left.length && shared < right.length && left[left.length - 1 - shared] === right[right.length - 1 - shared]) {
    shared++
  }
  return shared
}

/**
 * webpack interleaves client-reference-manifest chunk lists as
 * `[chunkId, chunkPath, chunkId, chunkPath, ...]` and URL-encodes dynamic
 * segments (`%5Bslug%5D`); Turbopack emits a flat list of `/_next/`-prefixed
 * paths. Keeping only entries naming a `.js` file handles both.
 */
export function normalizeChunkList(chunks: readonly string[]): string[] {
  return chunks.filter((c) => c.endsWith('.js')).map((c) => decodeURIComponent(c).replace(/^\/?_next\//, ''))
}
