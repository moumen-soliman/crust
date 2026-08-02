import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalizeChunkList } from '../analyze/source-map.ts'
import { readClientReferenceManifest } from '../manifests/read.ts'
import { toPosix } from '../core/workspace.ts'
import type { BundlerAdapter, AdapterContext } from './types.ts'

/**
 * webpack mirrors the app directory into the chunk tree:
 *   app/products/[slug]/page  ->  static/chunks/app/products/[slug]/page-<hash>.js
 * Turbopack has no such convention, which is why this lives behind the adapter
 * seam rather than in shared code.
 */
export const webpackAdapter: BundlerAdapter = {
  bundler: 'webpack',
  supportsStamping: true,

  async detect(distDir: string): Promise<boolean> {
    const chunks = await listChunks(distDir)
    if (chunks.some((c) => c.startsWith('static/chunks/turbopack-'))) return false
    return chunks.some((c) => c.startsWith('static/chunks/app/'))
  },

  async analyze(): Promise<never> {
    throw new Error('webpackAdapter.analyze is driven by analyzeBuild; use routeChunks instead')
  },
}

/** Chunks emitted for a route by the path convention. */
export async function conventionChunks(distDir: string, entry: string): Promise<string[]> {
  const prefix = toPosix(join('static/chunks/app', entry.replace(/^\//, '')))
  const all = await listChunks(distDir)
  return all.filter((c) => c.startsWith(prefix + '-') && c.endsWith('.js'))
}

/**
 * webpack's client reference manifest is the whole app's client module table, not
 * this route's — the manifest emitted for `/dashboard` lists chunks belonging to
 * `/`. Unioning it would attribute every client component to every route.
 *
 * A client module genuinely belongs to this route exactly when its own chunk list
 * contains this route's page chunk, so intersecting against the convention chunk
 * scopes the global table correctly without needing a webpack plugin.
 */
export async function scopedClientModules(
  distDir: string,
  entry: string,
): Promise<{ sources: string[]; chunks: string[] }> {
  const manifest = await readClientReferenceManifest(distDir, entry)
  const own = await conventionChunks(distDir, entry)
  if (!manifest || own.length === 0) return { sources: [], chunks: [] }

  const ownSet = new Set(own)
  const sources = new Set<string>()
  const chunks = new Set<string>()

  for (const [source, mod] of Object.entries(manifest.clientModules)) {
    const list = normalizeChunkList(mod.chunks ?? [])
    if (!list.some((c) => ownSet.has(c))) continue
    sources.add(source)
    for (const c of list) chunks.add(c)
  }

  return { sources: [...sources], chunks: [...chunks] }
}

let chunkCache = new Map<string, string[]>()

export async function listChunks(distDir: string): Promise<string[]> {
  const cached = chunkCache.get(distDir)
  if (cached) return cached

  const root = join(distDir, 'static')
  const out: string[] = []
  const recurse = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await recurse(full)
      else if (e.name.endsWith('.js')) out.push(toPosix(join('static', relative(root, full))))
    }
  }
  await recurse(root)
  out.sort()
  chunkCache.set(distDir, out)
  return out
}

/** Tests build several fixtures in one process; the chunk listing must not leak between them. */
export function clearChunkCache(): void {
  chunkCache = new Map()
}

export async function chunkSize(distDir: string, chunk: string): Promise<number> {
  try {
    return (await stat(join(distDir, chunk))).size
  } catch {
    return 0
  }
}
