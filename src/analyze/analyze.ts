import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { adapterFor, detectBundler } from '../adapters/detect.ts'
import type { Bundler, RenderingMode } from '../adapters/types.ts'
import { chunkSize, clearChunkCache, listChunks } from '../adapters/webpack.ts'
import { deriveBuildId } from '../core/build-id.ts'
import { shortHash } from '../core/hash.ts'
import { findWorkspaceRoot, indexWorkspace, readNextVersion, toPosix, type ProjectFileIndex } from '../core/workspace.ts'
import {
  readAppPathRoutes,
  readBuildManifest,
  readPrerenderManifest,
} from '../manifests/read.ts'
import { predictShell, type ShellRuleSet } from '../shell/predict.ts'
import { readActualShell } from '../shell/verify.ts'
import { SCHEMA_VERSION, type RouteSnapshot, type Snapshot } from '../store/snapshot.ts'
import { attributeChunk, mergeAttribution } from './attribution.ts'
import { buildModuleGraph, createResolver, layoutChainFor, propagateDynamicTaint, type ImportOverrides } from './module-graph.ts'

export interface AnalyzeOptions {
  cwd: string
  distDir?: string
  toolVersion: string
}

const SUPPORTED_MAJORS = [15, 16]

export async function analyzeBuild(options: AnalyzeOptions): Promise<Snapshot> {
  clearChunkCache()

  const projectDir = resolve(options.cwd)
  const distDir = resolve(projectDir, options.distDir ?? '.next')
  const warnings: string[] = []

  await assertBuildExists(distDir)

  const nextVersion = (await readNextVersion(projectDir)) ?? 'unknown'
  const major = Number(nextVersion.split('.')[0])
  if (!SUPPORTED_MAJORS.includes(major)) {
    // Refusing beats emitting numbers derived from artifacts whose shape we have
    // not verified. Two majors, both bundlers, fail loudly outside that (plan §3).
    throw new Error(
      `crust supports Next.js ${SUPPORTED_MAJORS.join(' and ')}; this project resolves next@${nextVersion}.`,
    )
  }

  const bundler = await detectBundler(distDir)
  if (!bundler) {
    throw new Error(`Could not tell which bundler produced ${relative(projectDir, distDir)}. Is it a production build?`)
  }

  const workspaceRoot = await findWorkspaceRoot(projectDir)
  const index = await indexWorkspace(workspaceRoot)
  const ruleSet = await detectRuleSet(distDir)
  const resolver = createResolver(await findTsconfig(projectDir))
  const appDir = await findAppDir(projectDir, index)
  const overrides = await readOverrides(workspaceRoot)

  // Pages Router: detect-and-warn (plan §2). A hybrid app still gets its App
  // Router routes analysed, with a warning that the pages/ half is invisible to
  // every number reported. Pages-only apps get a clear refusal, not a crash.
  const pagesDir = await findPagesDir(projectDir, index)
  if (pagesDir && appDir) {
    warnings.push(
      'Pages Router detected alongside the App Router. crust analyses app/ routes only; pages/ routes are not measured.',
    )
  }
  if (!appDir) {
    throw new Error(
      pagesDir
        ? 'This project uses the Pages Router, which crust does not analyse (a non-goal, stated in the README). App Router only.'
        : `No App Router directory found in ${projectDir}.`,
    )
  }

  const appPaths = await readAppPathRoutes(distDir)
  if (!appPaths) throw new Error('app-path-routes-manifest.json is missing; this build is not analysable.')

  const prerender = await readPrerenderManifest(distDir)
  const buildManifest = await readBuildManifest(distDir)
  const sharedRootChunks = [...(buildManifest?.rootMainFiles ?? []), ...(buildManifest?.polyfillFiles ?? [])]
  const sharedRootBytes = await sumChunkBytes(distDir, sharedRootChunks)

  // The framework runtime and polyfills are the bulk of first-load JS on almost
  // every route, so leaving them unattributed means blame can only ever name the
  // small route-specific modules - naming a 0.2 kB component as the cause of a
  // 543 kB budget breach. Attributed once, shared by every route.
  const sharedRootAttribution = { firstParty: new Map<string, number>(), dependencies: new Map<string, number>(), unattributed: 0 }
  for (const chunk of sharedRootChunks) {
    const attribution = await attributeChunk(distDir, chunk, index)
    mergeAttribution(sharedRootAttribution.firstParty, attribution.firstParty)
    mergeAttribution(sharedRootAttribution.dependencies, attribution.dependencies)
    sharedRootAttribution.unattributed += attribution.unattributedBytes
  }

  const routes: RouteSnapshot[] = []
  const allModules: Record<string, number> = {}

  for (const [entry, pattern] of Object.entries(appPaths.entryToPattern)) {
    // `_not-found`, `_global-error` and friends are framework-owned, not the
    // user's routes; reporting them as regressions is noise.
    if (entry.startsWith('/_')) continue

    const route = await analyzeRoute({
      entry,
      pattern,
      projectDir,
      distDir,
      appDir,
      bundler,
      index,
      resolver,
      ruleSet,
      prerender,
      overrides,
      sharedRootChunks,
      sharedRootBytes,
      sharedRootAttribution,
    })
    routes.push(route)
    for (const [file, bytes] of Object.entries(route.modules)) {
      allModules[file] = Math.max(allModules[file] ?? 0, bytes)
    }
    warnings.push(...route.warnings.map((w) => `${pattern}: ${w}`))
  }

  routes.sort((a, b) => a.pattern.localeCompare(b.pattern))

  const identity = await deriveBuildId({
    cwd: projectDir,
    nextVersion,
    bundler,
    configHash: await hashResolvedConfig(distDir),
    // Chunk filenames are content-hashed by both bundlers, so this changes exactly
    // when the emitted code does. Only consulted when there is no git identity.
    contentFallback: shortHash((await listChunks(distDir)).join('|')),
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: options.toolVersion,
    buildId: identity.buildId,
    createdAt: new Date().toISOString(),
    gitSha: identity.gitSha,
    committedAt: identity.committedAt,
    parentSha: identity.parentSha,
    branch: identity.branch,
    dirty: identity.dirty,
    nextVersion,
    nodeMajor: identity.nodeMajor,
    bundler,
    sourceSignature: sourceSignature(routes),
    routes,
    modules: allModules,
    warnings,
  }
}

interface RouteContext {
  entry: string
  pattern: string
  projectDir: string
  distDir: string
  appDir: string
  bundler: Bundler
  index: ProjectFileIndex
  resolver: ReturnType<typeof createResolver>
  ruleSet: ShellRuleSet
  prerender: Awaited<ReturnType<typeof readPrerenderManifest>>
  overrides: ImportOverrides
  sharedRootChunks: string[]
  sharedRootBytes: number
  sharedRootAttribution: { firstParty: Map<string, number>; dependencies: Map<string, number>; unattributed: number }
}

async function analyzeRoute(ctx: RouteContext): Promise<RouteSnapshot> {
  const warnings: string[] = []
  const adapter = adapterFor(ctx.bundler)

  const pageFileAbs = await findRouteFile(ctx.appDir, ctx.entry)
  const pageFile = pageFileAbs ? toPosix(relative(ctx.index.root, pageFileAbs)) : null

  const { sources: _clientSources, chunks } = await adapter.scopedClientModules(ctx.distDir, ctx.entry)
  const conventionOwned = new Set(await adapter.conventionChunks(ctx.distDir, ctx.entry))

  const firstParty = new Map<string, number>()
  const dependencies = new Map<string, number>()
  let routeBytes = 0
  let sharedBytes = 0
  let unattributed = ctx.sharedRootAttribution.unattributed

  mergeAttribution(firstParty, ctx.sharedRootAttribution.firstParty)
  mergeAttribution(dependencies, ctx.sharedRootAttribution.dependencies)

  for (const chunk of chunks) {
    const attribution = await attributeChunk(ctx.distDir, chunk, ctx.index)
    mergeAttribution(firstParty, attribution.firstParty)
    mergeAttribution(dependencies, attribution.dependencies)
    unattributed += attribution.unattributedBytes
    if (conventionOwned.has(chunk) || chunks.length === 1) routeBytes += attribution.bytes
    else sharedBytes += attribution.bytes
    if (attribution.reason) warnings.push(`${chunk}: ${attribution.reason}`)
  }

  // Module graph and shell prediction need the page's source; without it the
  // route still reports byte totals, just no attribution or prediction.
  let dynamicReasons: string[] = []
  let clientBoundaryRoots: string[] = []
  let shell: RouteSnapshot['shell'] = null

  if (pageFileAbs && pageFile) {
    const graph = await buildModuleGraph(pageFileAbs, ctx.index, ctx.resolver, ctx.overrides)

    for (const layout of layoutChainFor(pageFile, ctx.index)) {
      const layoutAbs = join(ctx.index.root, layout)
      const layoutGraph = await buildModuleGraph(layoutAbs, ctx.index, ctx.resolver, ctx.overrides)
      for (const [file, node] of layoutGraph.nodes) if (!graph.nodes.has(file)) graph.nodes.set(file, node)
    }

    warnings.push(...graph.warnings)

    const taint = propagateDynamicTaint(graph)
    dynamicReasons = [...new Set((taint.get(pageFile) ?? []).slice(0, 8))]
    clientBoundaryRoots = [...graph.nodes.values()].filter((n) => n.isClientBoundaryRoot).map((n) => n.file)

    const prediction = predictShell(graph, taint, pageFile, ctx.ruleSet)
    const actual = await readActualShell(ctx.distDir, ctx.pattern)

    shell = {
      predictedStatic: prediction.predictedStatic,
      predictedHoles: prediction.predictedHoles,
      actual,
      agreement: actual ? agreementBetween(prediction.predictedStatic, prediction.predictedHoles.length, actual.holes) : null,
      unknown: prediction.unknown,
    }
  } else {
    warnings.push(`could not locate the source file for ${ctx.entry}`)
  }

  // Route handlers have no client bundle, no shell and no rendering mode - they
  // are server functions. Reporting them as "unknown" implies a gap in the
  // analysis when there is nothing there to analyse.
  const isRouteHandler = ctx.entry.endsWith('/route') && !pageFile?.match(/opengraph-image|icon|apple-icon/)

  const { mode, reason } = isRouteHandler
    ? { mode: 'ROUTE_HANDLER' as const, reason: null }
    : renderingModeFor(ctx, dynamicReasons, shell?.actual ?? null)

  return {
    id: pageFile ?? ctx.entry,
    pattern: ctx.pattern,
    filePath: pageFile,
    renderingMode: mode,
    renderingModeReason: reason,
    // A route handler is a server function: no client bundle, no shared runtime,
    // no first load. Adding the app-wide chunks to it reports `/api/callback` as
    // shipping 800 kB of JavaScript to a browser that never loads any.
    firstLoadBytes: isRouteHandler ? 0 : routeBytes + sharedBytes + ctx.sharedRootBytes,
    routeBytes: isRouteHandler ? 0 : routeBytes,
    sharedBytes: isRouteHandler ? 0 : sharedBytes,
    unattributedBytes: isRouteHandler ? 0 : unattributed,
    modules: Object.fromEntries([...firstParty].sort((a, b) => b[1] - a[1])),
    dependencies: Object.fromEntries([...dependencies].sort((a, b) => b[1] - a[1])),
    dynamicReasons,
    clientBoundaryRoots,
    shell,
    warnings,
  }
}

/**
 * Agreement is deliberately coarse: whether the predictor found the same number of
 * holes the build produced. Component-level agreement needs the stamping transform
 * to map DOM positions back to component names (R4), which is not built.
 */
function agreementBetween(predictedStatic: string[], predictedHoles: number, actualHoles: number): number | null {
  if (predictedStatic.length === 0 && predictedHoles === 0 && actualHoles === 0) return 1
  if (actualHoles === 0 && predictedHoles === 0) return 1
  const worst = Math.max(predictedHoles, actualHoles)
  if (worst === 0) return 1
  return Math.max(0, 1 - Math.abs(predictedHoles - actualHoles) / worst)
}

function renderingModeFor(
  ctx: RouteContext,
  dynamicReasons: string[],
  actual: { holes: number } | null,
): { mode: RenderingMode | 'unknown'; reason: string | null } {
  const prerendered = ctx.prerender?.routes[ctx.pattern]

  // A prerendered route that shipped pending boundaries is partially static, not
  // static. The prerender manifest cannot distinguish the two - it lists both the
  // same way - so the emitted shell is the only thing that actually knows.
  if (actual && actual.holes > 0) {
    return { mode: 'PARTIALLY_STATIC', reason: dynamicReasons[0] ?? null }
  }

  if (prerendered) {
    if (prerendered.initialRevalidateSeconds !== false) {
      return { mode: 'ISR', reason: `revalidate=${prerendered.initialRevalidateSeconds}` }
    }
    return { mode: 'STATIC', reason: null }
  }

  // `srcRoute` names the dynamic pattern a concrete prerendered path came from.
  // Prefix-matching instead is catastrophically loose: `/[locale]/about` truncates
  // to `/`, which every prerendered route starts with, so a real app reported all
  // 25 routes as partially static.
  const prerenderedInstances = Object.values(ctx.prerender?.routes ?? {}).some((r) => r.srcRoute === ctx.pattern)
  if (prerenderedInstances) {
    return { mode: 'STATIC', reason: 'prerendered via generateStaticParams' }
  }
  if (dynamicReasons.length > 0) return { mode: 'DYNAMIC', reason: dynamicReasons[0]! }

  // Something made this route dynamic that we could not see in source. Saying
  // DYNAMIC would be a guess dressed as a fact.
  return { mode: 'unknown', reason: 'not prerendered, and no dynamic API found in source' }
}

/* ── discovery helpers ─────────────────────────────────────────────────── */

async function assertBuildExists(distDir: string): Promise<void> {
  try {
    await stat(join(distDir, 'app-path-routes-manifest.json'))
  } catch {
    throw new Error(
      `No production build found at ${distDir}. crust measures production builds only - dev numbers are unminified, unbundled fiction.`,
    )
  }
}

async function readOverrides(root: string): Promise<ImportOverrides> {
  try {
    return JSON.parse(await readFile(join(root, '.perf', 'overrides.json'), 'utf8')) as ImportOverrides
  } catch {
    return {}
  }
}

async function findPagesDir(projectDir: string, index: ProjectFileIndex): Promise<string | null> {
  for (const candidate of ['pages', 'src/pages']) {
    const abs = join(projectDir, candidate)
    const rel = toPosix(relative(index.root, abs))
    for (const file of index.files) {
      if (file.startsWith(rel + '/') && /\.[jt]sx?$/.test(file)) return abs
    }
  }
  return null
}

async function findAppDir(projectDir: string, index: ProjectFileIndex): Promise<string | null> {
  for (const candidate of ['app', 'src/app']) {
    const abs = join(projectDir, candidate)
    const rel = toPosix(relative(index.root, abs))
    for (const file of index.files) {
      if (file.startsWith(rel + '/')) return abs
    }
  }
  return null
}

async function findRouteFile(appDir: string, entry: string): Promise<string | null> {
  const bases = [join(appDir, entry.replace(/^\//, ''))]

  // Metadata routes report as `/opengraph-image/route` but live at
  // `app/opengraph-image.tsx`, with no `route` file anywhere.
  if (entry.endsWith('/route')) bases.push(join(appDir, entry.replace(/^\//, '').replace(/\/route$/, '')))

  for (const base of bases) {
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      const candidate = `${base}.${ext}`
      try {
        await stat(candidate)
        return candidate
      } catch {
        // Try the next extension.
      }
    }
  }
  return null
}

async function findTsconfig(projectDir: string): Promise<string | null> {
  const candidate = join(projectDir, 'tsconfig.json')
  try {
    await stat(candidate)
    return candidate
  } catch {
    return null
  }
}

/**
 * The rule set comes from the build's own resolved config rather than from parsing
 * next.config, which may be TypeScript, may compute values, and may not be
 * statically readable at all. Getting this wrong means confidently wrong shell
 * predictions, which is worse than no prediction (R5).
 */
async function detectRuleSet(distDir: string): Promise<ShellRuleSet> {
  const config = await readResolvedConfig(distDir)
  if (config?.cacheComponents === true) return 'cache-components'
  return 'legacy-ppr'
}

async function readResolvedConfig(distDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(distDir, 'required-server-files.json'), 'utf8')
    return (JSON.parse(raw) as { config?: Record<string, unknown> }).config ?? null
  } catch {
    return null
  }
}

async function hashResolvedConfig(distDir: string): Promise<string> {
  const config = await readResolvedConfig(distDir)
  if (!config) return 'unknown'
  // distDir and generated ids vary between otherwise identical builds.
  const { distDir: _d, generateBuildId: _g, ...rest } = config
  return shortHash(JSON.stringify(rest, Object.keys(rest).sort()))
}

async function sumChunkBytes(distDir: string, chunks: string[]): Promise<number> {
  let total = 0
  for (const chunk of chunks) total += await chunkSize(distDir, chunk)
  return total
}

/** Content signature used to re-link snapshots orphaned by squash merges (R13). */
function sourceSignature(routes: RouteSnapshot[]): string {
  const parts = routes.map((r) => `${r.id}:${Object.keys(r.modules).sort().join(',')}`)
  return shortHash(parts.sort().join('|'))
}
