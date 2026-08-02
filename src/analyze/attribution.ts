import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping'
import { readSourceMap, resolveFirstParty } from './source-map.ts'
import type { ProjectFileIndex } from '../core/workspace.ts'

export const OUTSIDE_PROJECT = '(outside project, package not identifiable)'

export interface ChunkAttribution {
  chunk: string
  bytes: number
  /** Bytes attributed to a source file, keyed by workspace-relative path. */
  firstParty: Map<string, number>
  /** Bytes attributed to dependencies, keyed by package name. */
  dependencies: Map<string, number>
  /** Bytes no mapping covers — bundler runtime, or a chunk with no map at all. */
  unattributedBytes: number
  /** Set when the chunk shipped without a source map; the bytes are real but blind. */
  reason: string | null
}

/**
 * Attribute a chunk's bytes to the source files that produced them.
 *
 * Mappings are walked in generated-position order and each one owns the bytes from
 * its own position to the next. Regions no mapping covers are counted as
 * unattributed rather than smeared onto the nearest source — knowing how much we
 * genuinely cannot explain is the point, and a tool that quietly rounds unknowns
 * into confident numbers is worse than one that reports nothing (plan §3).
 */
export async function attributeChunk(
  distDir: string,
  chunk: string,
  index: ProjectFileIndex,
): Promise<ChunkAttribution> {
  const path = join(distDir, chunk)
  let code: string
  try {
    code = await readFile(path, 'utf8')
  } catch {
    return empty(chunk, 0, 'chunk missing from build output')
  }

  const bytes = Buffer.byteLength(code)
  const rawMap = await readSourceMap(path, code)
  if (rawMap === null) return empty(chunk, bytes, 'no source map emitted for this chunk')

  let map: TraceMap
  try {
    map = new TraceMap(JSON.parse(rawMap) as ConstructorParameters<typeof TraceMap>[0])
  } catch {
    return empty(chunk, bytes, 'source map could not be parsed')
  }

  const lineStarts = byteOffsetsPerLine(code)
  const points: { offset: number; source: string | null }[] = []

  eachMapping(map, (m) => {
    const start = lineStarts[m.generatedLine - 1]
    if (start === undefined) return
    points.push({ offset: start + m.generatedColumn, source: m.source })
  })

  if (points.length === 0) return empty(chunk, bytes, 'source map contained no mappings')

  points.sort((a, b) => a.offset - b.offset)

  const firstParty = new Map<string, number>()
  const dependencies = new Map<string, number>()
  // Everything before the first mapping is bundler preamble, owned by no source.
  let unattributed = points[0]!.offset

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const end = i + 1 < points.length ? points[i + 1]!.offset : bytes
    const span = Math.max(0, end - point.offset)
    if (span === 0) continue

    if (point.source === null) {
      unattributed += span
      continue
    }

    const own = resolveFirstParty(point.source, index)
    if (own) {
      firstParty.set(own, (firstParty.get(own) ?? 0) + span)
      continue
    }

    const pkg = packageNameOf(point.source)
    if (pkg) {
      dependencies.set(pkg, (dependencies.get(pkg) ?? 0) + span)
      continue
    }

    // Mapped, but to a path with no package name in it. Next ships maps pointing
    // at its own `../../../src/...`, so these bytes are accounted for — we just
    // cannot name the package without guessing. Counting them as unattributed
    // would overstate how blind the analysis is, and naming them `next` would be
    // a guess that happens to be right today.
    const outside = point.source.replace(/^[a-z-]+:\/\/[^/]*\//, '')
    if (outside.startsWith('..') || outside.startsWith('/')) {
      dependencies.set(OUTSIDE_PROJECT, (dependencies.get(OUTSIDE_PROJECT) ?? 0) + span)
      continue
    }

    unattributed += span
  }

  return { chunk, bytes, firstParty, dependencies, unattributedBytes: unattributed, reason: null }
}

/**
 * `node_modules/.pnpm/next@16.2.12_.../node_modules/next/dist/x.js` -> `next`.
 * The pnpm virtual store segment has to be skipped or every package would be
 * reported under its own mangled versioned directory name.
 */
export function packageNameOf(sourceUrl: string): string | null {
  const segments = sourceUrl.split('/')
  let last = -1
  for (let i = 0; i < segments.length; i++) if (segments[i] === 'node_modules') last = i
  if (last === -1) return null

  const first = segments[last + 1]
  if (!first) return null
  if (first.startsWith('@')) {
    const second = segments[last + 2]
    return second ? `${first}/${second}` : first
  }
  return first
}

function byteOffsetsPerLine(code: string): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const line of code.split('\n')) {
    offsets.push(acc)
    acc += Buffer.byteLength(line) + 1
  }
  return offsets
}

function empty(chunk: string, bytes: number, reason: string | null): ChunkAttribution {
  return {
    chunk,
    bytes,
    firstParty: new Map(),
    dependencies: new Map(),
    unattributedBytes: bytes,
    reason,
  }
}

export function mergeAttribution(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}
