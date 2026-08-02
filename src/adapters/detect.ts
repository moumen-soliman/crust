import { turbopackAdapter } from './turbopack.ts'
import { webpackAdapter } from './webpack.ts'
import type { Bundler, BundlerAdapter } from './types.ts'

import * as webpackImpl from './webpack.ts'
import * as turbopackImpl from './turbopack.ts'

export interface ResolvedAdapter {
  adapter: BundlerAdapter
  /** Route entry -> the client sources and chunks that genuinely belong to it. */
  scopedClientModules(distDir: string, entry: string): Promise<{ sources: string[]; chunks: string[] }>
  /** Chunks named by the bundler's own path convention, if it has one. */
  conventionChunks(distDir: string, entry: string): Promise<string[]>
}

const IMPLS: Record<Bundler, ResolvedAdapter> = {
  webpack: {
    adapter: webpackAdapter,
    scopedClientModules: webpackImpl.scopedClientModules,
    conventionChunks: webpackImpl.conventionChunks,
  },
  turbopack: {
    adapter: turbopackAdapter,
    scopedClientModules: turbopackImpl.scopedClientModules,
    conventionChunks: async () => [],
  },
}

export function adapterFor(bundler: Bundler): ResolvedAdapter {
  return IMPLS[bundler]
}

/**
 * Turbopack is checked first: its marker chunk (`static/chunks/turbopack-*.js`)
 * is unambiguous, while webpack's is the absence of one.
 */
export async function detectBundler(distDir: string): Promise<Bundler | null> {
  if (await turbopackAdapter.detect(distDir)) return 'turbopack'
  if (await webpackAdapter.detect(distDir)) return 'webpack'
  return null
}
