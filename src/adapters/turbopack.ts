import { normalizeChunkList } from '../analyze/source-map.ts'
import { readClientReferenceManifest } from '../manifests/read.ts'
import { listChunks } from './webpack.ts'
import type { BundlerAdapter } from './types.ts'

/**
 * Turbopack emits flat, content-hashed chunk names with no relationship to the
 * route tree, so the webpack path convention finds nothing. In exchange its
 * client reference manifest is genuinely route-scoped, so the chunk lists can be
 * unioned directly - the opposite of webpack, where they must be intersected.
 *
 * Stamping is unsupported: there is no custom loader equivalent, and an SWC
 * plugin is Rust with a real build and distribution burden (R4). Attribution
 * falls back to source maps, which measured *better* here than on webpack.
 */
export const turbopackAdapter: BundlerAdapter = {
  bundler: 'turbopack',
  supportsStamping: false,

  async detect(distDir: string): Promise<boolean> {
    const chunks = await listChunks(distDir)
    return chunks.some((c) => c.startsWith('static/chunks/turbopack-'))
  },

  async analyze(): Promise<never> {
    throw new Error('turbopackAdapter.analyze is driven by analyzeBuild; use routeChunks instead')
  },
}

export async function scopedClientModules(
  distDir: string,
  entry: string,
): Promise<{ sources: string[]; chunks: string[] }> {
  const manifest = await readClientReferenceManifest(distDir, entry)
  if (!manifest) return { sources: [], chunks: [] }

  const sources = new Set<string>()
  const chunks = new Set<string>()

  for (const [source, mod] of Object.entries(manifest.clientModules)) {
    const list = normalizeChunkList(mod.chunks ?? [])
    if (list.length === 0) continue
    // Turbopack keys some entries as `<path> <module evaluation>`; the trailing
    // marker is not part of the file path and would break source resolution.
    sources.add(source.replace(/ <module evaluation>$/, ''))
    for (const c of list) chunks.add(c)
  }

  return { sources: [...sources], chunks: [...chunks] }
}
