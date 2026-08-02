/**
 * Phase 0 spike - throwaway, deliberately not part of the package.
 *
 * Questions it has to answer (plan §8):
 *   1. Can we get route -> chunk -> module -> source file?
 *   2. Do our totals match what `next build` reports?
 *   3. Does the build emit usable shell artifacts?
 *
 * Kill criterion: under ~85% module attribution accuracy means the
 * "blame the import" premise is weak and Phase 1 rescopes to route totals.
 *
 * Run: node spike/phase0.ts fixtures/basic
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping'

const projectDir = resolve(process.argv[2] ?? 'fixtures/basic')
const distDir = join(projectDir, process.argv[3] ?? '.next')

type SourceBytes = Map<string, number>

async function main() {
  console.log(`\n# Phase 0 spike - ${relative(process.cwd(), projectDir)}\n`)
  await indexProjectFiles()

  await q1RouteToChunk()
  await q2SourceMapAttribution()
  await q3ShellArtifacts()
  await q4RouteToSource()
}

/* ── Q1: route -> chunk ────────────────────────────────────────────────── */

async function q1RouteToChunk() {
  console.log('## Q1  route -> chunk\n')

  const appPaths: Record<string, string> = JSON.parse(
    await readFile(join(distDir, 'app-path-routes-manifest.json'), 'utf8'),
  )

  for (const [entry, pattern] of Object.entries(appPaths)) {
    const byConvention = await chunksByPathConvention(entry)
    const byManifest = await chunksFromClientReferenceManifest(entry)

    const sizes = await Promise.all(
      [...new Set([...byConvention, ...byManifest])].map(async (f) => {
        try {
          return (await stat(join(distDir, f))).size
        } catch {
          return 0
        }
      }),
    )
    const total = sizes.reduce((a, b) => a + b, 0)
    const source =
      byConvention.length && byManifest.length
        ? 'both'
        : byConvention.length
          ? 'path convention (webpack)'
          : byManifest.length
            ? 'client-reference-manifest (turbopack)'
            : 'NONE'
    console.log(
      `  ${pattern.padEnd(20)} ${String(byConvention.length + byManifest.length).padStart(2)} chunk(s) ${kb(total).padStart(9)}  via ${source}`,
    )
  }
  console.log()
}

/** webpack mirrors the app directory into `static/chunks/app/...`. Turbopack does not. */
async function chunksByPathConvention(entry: string): Promise<string[]> {
  const chunkDir = join(distDir, 'static', 'chunks')
  const prefix = join('app', entry.replace(/^\//, ''))
  const all = await walk(chunkDir)
  return all
    .map((c) => relative(chunkDir, c))
    .filter((rel) => rel.startsWith(prefix + '-') && rel.endsWith('.js'))
    .map((rel) => join('static', 'chunks', rel))
}

/**
 * Turbopack populates `clientModules[source].chunks`; webpack leaves it empty and
 * relies on the path convention instead. Same manifest, inverted usefulness - the
 * clearest example so far of why the two bundlers need one interface and two
 * implementations rather than an inline branch (R2).
 */
async function chunksFromClientReferenceManifest(entry: string): Promise<string[]> {
  const file = join(distDir, 'server', 'app', entry.replace(/^\//, '') + '_client-reference-manifest.js')
  let src: string
  try {
    src = await readFile(file, 'utf8')
  } catch {
    return []
  }
  // The file assigns to `globalThis.__RSC_MANIFEST`; older Next wrote to `self`.
  // Running it in a vm context beats eval - it can't touch our globals.
  const sandbox: { __RSC_MANIFEST?: Record<string, unknown>; self?: { __RSC_MANIFEST?: Record<string, unknown> } } = {}
  sandbox.self = sandbox as { __RSC_MANIFEST?: Record<string, unknown> }
  try {
    runInNewContext(src, sandbox)
  } catch {
    return []
  }
  const raw = sandbox.__RSC_MANIFEST?.[entry] ?? sandbox.self?.__RSC_MANIFEST?.[entry]
  if (!raw) return []
  const manifest: ClientReferenceManifest =
    typeof raw === 'string' ? (JSON.parse(raw) as ClientReferenceManifest) : (raw as ClientReferenceManifest)
  const out = new Set<string>()
  for (const mod of Object.values(manifest.clientModules ?? {})) {
    for (const chunk of normalizeChunkList(mod.chunks ?? [])) out.add(chunk)
  }
  return [...out]
}

/**
 * webpack interleaves the list as [chunkId, chunkPath, chunkId, chunkPath, ...]
 * and URL-encodes dynamic segments (`%5Bslug%5D`). Turbopack emits a flat list of
 * `/_next/`-prefixed paths. Keeping only the entries that name a `.js` file
 * handles both without having to know which bundler produced the manifest.
 */
function normalizeChunkList(chunks: string[]): string[] {
  return chunks
    .filter((c) => c.endsWith('.js'))
    .map((c) => decodeURIComponent(c).replace(/^\/?_next\//, ''))
}

interface ClientReferenceManifest {
  clientModules?: Record<string, { chunks?: string[] }>
}

/* ── Q2: chunk -> module -> source file, via source maps ───────────────── */

async function q2SourceMapAttribution() {
  console.log('## Q2  chunk -> source file (source maps)\n')

  const chunkDir = join(distDir, 'static', 'chunks')
  const files = (await walk(chunkDir)).filter((f) => f.endsWith('.js'))

  let mapped = 0
  let unmapped = 0
  const perSource: SourceBytes = new Map()

  for (const file of files) {
    const code = await readFile(file, 'utf8')
    const raw = await readSourceMap(file, code)
    if (raw === null) {
      unmapped += Buffer.byteLength(code)
      console.log(`  ${relative(chunkDir, file).padEnd(56)} NO MAP  (${kb(Buffer.byteLength(code))})`)
      continue
    }
    const attributed = attributeChunk(code, raw, perSource)
    mapped += attributed.mapped
    unmapped += attributed.unmapped
  }

  const total = mapped + unmapped
  const pct = total === 0 ? 0 : (mapped / total) * 100
  console.log(`\n  attributed ${kb(mapped)} of ${kb(total)}  ->  ${pct.toFixed(1)}%`)
  console.log(`  ${pct >= 85 ? 'PASS' : 'BELOW KILL THRESHOLD'} (threshold 85%)\n`)

  const ranked = [...perSource.entries()].sort((a, b) => b[1] - a[1])
  console.log('  top sources by attributed bytes:')
  for (const [src, bytes] of ranked.slice(0, 15)) {
    console.log(`    ${kb(bytes).padStart(9)}  ${prettySource(src)}`)
  }

  // `webpack://_N_E/./x` is project-relative - the app's own code. Next's own
  // internals show up as `webpack://_N_E/../../src/...`, which is why a bare
  // "does it contain node_modules" check misclassifies them as first-party.
  const firstParty = ranked.filter(([s]) => isFirstParty(s))
  const fpTotal = firstParty.reduce((a, [, b]) => a + b, 0)
  console.log(`\n  first-party sources resolved: ${firstParty.length} (${kb(fpTotal)})`)
  for (const [src, bytes] of firstParty) {
    console.log(`    ${kb(bytes).padStart(9)}  ${prettySource(src)}`)
  }
  console.log()
}

/**
 * Turbopack names maps independently of their chunk (`3cqmf8g.js` ->
 * `3ixj0_2m.js.map`), so `chunk + '.map'` finds nothing there and makes
 * attribution look impossible. The `sourceMappingURL` comment is the only
 * correct link; the sibling-file guess is just a fallback for maps whose
 * comment was stripped.
 */
async function readSourceMap(file: string, code: string): Promise<string | null> {
  const match = /[#@]\s*sourceMappingURL=(\S+)/.exec(code)
  if (match?.[1] && !match[1].startsWith('data:')) {
    try {
      return await readFile(join(file, '..', decodeURIComponent(match[1])), 'utf8')
    } catch {
      // Fall through to the sibling guess.
    }
  }
  try {
    return await readFile(file + '.map', 'utf8')
  } catch {
    return null
  }
}

/**
 * Walk the mappings in generated-position order. Each mapping owns the bytes
 * from its own position up to the next mapping's position. Bytes before the
 * first mapping on a line, or in a chunk region no mapping covers, are counted
 * unattributed rather than smeared onto the nearest source - the whole point is
 * to know how much we genuinely can't explain.
 */
function attributeChunk(code: string, rawMap: string, out: SourceBytes) {
  const map = new TraceMap(JSON.parse(rawMap))
  const lines = code.split('\n')
  const lineOffsets: number[] = []
  let acc = 0
  for (const line of lines) {
    lineOffsets.push(acc)
    acc += Buffer.byteLength(line) + 1
  }
  const totalBytes = Buffer.byteLength(code)

  type Point = { offset: number; source: string | null }
  const points: Point[] = []

  eachMapping(map, (m) => {
    if (m.generatedLine == null) return
    const lineStart = lineOffsets[m.generatedLine - 1]
    if (lineStart == null) return
    points.push({ offset: lineStart + (m.generatedColumn ?? 0), source: m.source ?? null })
  })

  points.sort((a, b) => a.offset - b.offset)

  let mapped = 0
  let unmapped = 0

  if (points.length === 0) return { mapped: 0, unmapped: totalBytes }

  // Bytes before the first mapping belong to no source (bundler runtime preamble).
  unmapped += points[0]!.offset

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const end = i + 1 < points.length ? points[i + 1]!.offset : totalBytes
    const span = Math.max(0, end - point.offset)
    if (point.source) {
      mapped += span
      out.set(point.source, (out.get(point.source) ?? 0) + span)
    } else {
      unmapped += span
    }
  }

  return { mapped, unmapped }
}

/* ── Q3: shell artifacts ───────────────────────────────────────────────── */

async function q3ShellArtifacts() {
  console.log('## Q3  shell artifacts\n')

  const serverApp = join(distDir, 'server', 'app')
  const files = await walk(serverApp).catch(() => [])

  const html = files.filter((f) => f.endsWith('.html'))
  const meta = files.filter((f) => f.endsWith('.meta'))
  const segments = files.filter((f) => f.includes('.segments' + sep))

  console.log(`  prerendered HTML:   ${html.length}`)
  for (const f of html) console.log(`    ${relative(serverApp, f)}  (${kb((await stat(f)).size)})`)
  console.log(`  .meta sidecars:     ${meta.length}`)
  console.log(`  segment RSC files:  ${segments.length}`)

  const postponed = files.filter((f) => f.endsWith('.postponed') || f.endsWith('.json.postponed'))
  console.log(`  postponed state:    ${postponed.length} (never parsed - opaque by contract)`)

  // Does any prerendered HTML contain a Suspense fallback sitting in its hole?
  for (const f of html) {
    const src = await readFile(f, 'utf8')
    const hasFallback = src.includes('gallery-fallback')
    const boundaries = (src.match(/<!--\$\?-->/g) ?? []).length
    console.log(`    ${relative(serverApp, f)}: suspense holes=${boundaries} fixtureFallback=${hasFallback}`)
  }
  console.log()
}

/* ── Q4: route -> first-party source, end to end ───────────────────────── */

async function q4RouteToSource() {
  console.log('## Q4  route -> first-party source (the product claim)\n')

  const appPaths: Record<string, string> = JSON.parse(
    await readFile(join(distDir, 'app-path-routes-manifest.json'), 'utf8'),
  )
  const chunkDir = join(distDir, 'static', 'chunks')
  const chunks = await walk(chunkDir)

  for (const [entry, pattern] of Object.entries(appPaths)) {
    if (entry.startsWith('/_')) continue
    const prefix = join('app', entry.replace(/^\//, ''))
    const routeChunks = chunks.filter((c) => {
      const rel = relative(chunkDir, c)
      return rel.startsWith(prefix + '-') && rel.endsWith('.js')
    })

    const perSource: SourceBytes = new Map()
    for (const c of routeChunks) {
      try {
        attributeChunk(await readFile(c, 'utf8'), await readFile(c + '.map', 'utf8'), perSource)
      } catch {
        // No map for this chunk - nothing to attribute.
      }
    }
    const own = [...perSource.entries()].filter(([s]) => isFirstParty(s)).sort((a, b) => b[1] - a[1])
    console.log(`  ${pattern}`)
    if (own.length === 0) console.log('    (no first-party client code)')
    for (const [src, bytes] of own) console.log(`    ${kb(bytes).padStart(9)}  ${prettySource(src)}`)
  }
  console.log()
}

/* ── helpers ───────────────────────────────────────────────────────────── */

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`

/**
 * Prefix checks don't work here: TraceMap resolves source URLs, which collapses
 * `webpack://_N_E/./components/Gallery.tsx` and `webpack://_N_E/../../src/x.ts`
 * into the same shape. Next ships maps pointing at its own `src/`, so a naive
 * check reports Next's router as the app's code.
 *
 * The reliable test is whether the source resolves to a file that actually
 * exists in the project. Cheap, and it can't be fooled by namespace collisions.
 */
let projectFiles: Set<string> | null = null

async function indexProjectFiles(): Promise<Set<string>> {
  if (projectFiles) return projectFiles
  const out = new Set<string>()
  const skip = new Set(['node_modules', '.next', '.git'])
  const recurse = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await recurse(full)
      else out.add(relative(projectDir, full))
    }
  }
  await recurse(projectDir)
  projectFiles = out
  return out
}

/**
 * The two bundlers anchor source paths differently. webpack emits
 * `webpack://_N_E/./components/Gallery.tsx` (project-relative). Turbopack emits
 * `turbopack:///[project]/<path>` where `[project]` is whatever root it inferred -
 * which is the workspace root, not the app dir, whenever an outer lockfile exists.
 *
 * Rather than special-casing each scheme, take the longest path suffix that names
 * a file actually present in the project. Longest-first keeps `app/page.tsx` from
 * being claimed by a bare `page.tsx` match.
 */
function toProjectPath(src: string): string | null {
  const stripped = src
    .replace(/^[a-z-]+:\/\/[^/]*\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^\.\//, '')
    .replace(/\?[0-9a-f]+$/, '')
  if (stripped.includes('node_modules')) return null

  const segments = stripped.split('/')
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/')
    if (projectFiles?.has(candidate)) return candidate
  }
  return null
}

function isFirstParty(src: string): boolean {
  return toProjectPath(src) !== null
}

function prettySource(src: string): string {
  return (
    toProjectPath(src) ??
    src
  )
    .replace(/^[a-z-]+:\/\/[^/]*\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^\.\//, '')
    .replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'node_modules/')
}

await main()
