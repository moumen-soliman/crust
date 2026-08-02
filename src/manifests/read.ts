import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/**
 * Readers for what Next actually emits in 16.x.
 *
 * Note what is NOT here: `app-build-manifest.json`, which the original plan listed
 * as the route -> client chunk source, does not exist. `build-manifest.json` carries
 * no App Router route data at all — only the shared root files. Route -> chunk comes
 * from the per-route client reference manifest and, on webpack, the chunk path
 * convention (docs/phase-0-findings.md).
 */

export interface AppPathRoutes {
  /** `/products/[slug]/page` -> `/products/[slug]` */
  entryToPattern: Record<string, string>
}

export async function readAppPathRoutes(distDir: string): Promise<AppPathRoutes | null> {
  const raw = await readJson<Record<string, string>>(join(distDir, 'app-path-routes-manifest.json'))
  return raw ? { entryToPattern: raw } : null
}

export interface BuildManifest {
  polyfillFiles: string[]
  rootMainFiles: string[]
  lowPriorityFiles: string[]
}

export async function readBuildManifest(distDir: string): Promise<BuildManifest | null> {
  const raw = await readJson<Partial<BuildManifest>>(join(distDir, 'build-manifest.json'))
  if (!raw) return null
  return {
    polyfillFiles: raw.polyfillFiles ?? [],
    rootMainFiles: raw.rootMainFiles ?? [],
    lowPriorityFiles: raw.lowPriorityFiles ?? [],
  }
}

export interface PrerenderManifest {
  routes: Record<string, { srcRoute: string | null; initialRevalidateSeconds: number | false; dataRoute: string | null }>
  dynamicRoutes: Record<string, { fallback?: unknown }>
}

export async function readPrerenderManifest(distDir: string): Promise<PrerenderManifest | null> {
  const raw = await readJson<Partial<PrerenderManifest>>(join(distDir, 'prerender-manifest.json'))
  if (!raw) return null
  return { routes: raw.routes ?? {}, dynamicRoutes: raw.dynamicRoutes ?? {} }
}

export interface RoutesManifest {
  dynamicRoutes: { page: string; regex: string }[]
  staticRoutes: { page: string; regex: string }[]
}

export async function readRoutesManifest(distDir: string): Promise<RoutesManifest | null> {
  const raw = await readJson<Partial<RoutesManifest>>(join(distDir, 'routes-manifest.json'))
  if (!raw) return null
  return { dynamicRoutes: raw.dynamicRoutes ?? [], staticRoutes: raw.staticRoutes ?? [] }
}

export interface ClientReferenceManifest {
  /** Absolute source path -> the chunks that module lands in. */
  clientModules: Record<string, { id?: string | number; chunks?: string[] }>
}

/**
 * Per-route client reference manifest. On Turbopack the chunk lists are genuinely
 * route-scoped; on webpack the same file contains the whole app's client module
 * table, so its chunk lists must not be unioned as if they were this route's
 * (see docs/phase-0-findings.md §2).
 */
export async function readClientReferenceManifest(
  distDir: string,
  entry: string,
): Promise<ClientReferenceManifest | null> {
  const file = join(distDir, 'server', 'app', entry.replace(/^\//, '') + '_client-reference-manifest.js')
  let src: string
  try {
    src = await readFile(file, 'utf8')
  } catch {
    return null
  }

  // The file assigns to `globalThis.__RSC_MANIFEST` (older Next used `self`).
  // A vm context beats eval: the script cannot reach our globals.
  type Sandbox = { __RSC_MANIFEST?: Record<string, unknown>; self?: unknown }
  const sandbox: Sandbox = {}
  sandbox.self = sandbox
  try {
    runInNewContext(src, sandbox, { timeout: 5_000 })
  } catch {
    return null
  }

  const raw = sandbox.__RSC_MANIFEST?.[entry]
  if (raw == null) return null
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<ClientReferenceManifest>
  return { clientModules: parsed.clientModules ?? {} }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}
