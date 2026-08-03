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
import {
  SCHEMA_VERSION,
  type BarrelCost,
  type CauseChain,
  type ClientBoundary,
  type Coverage,
  type RouteSnapshot,
  type Snapshot,
} from '../store/snapshot.ts'
import { createChunkAttributor, mergeAttribution, type ChunkAttributor } from './attribution.ts'
import { sharedCausesFor } from './blast.ts'
import { buildBytesCause, buildCauseChain } from './cause.ts'
import { readBuildConfig } from './config.ts'
import { computeCoverage } from './coverage.ts'
import { barrelCosts, boundaryCosts } from './shape.ts'
import {
  baseReason,
  buildModuleGraph,
  createResolver,
  layoutChainFor,
  propagateDynamicTaint,
  reachableTaint,
  type ImportOverrides,
  type ModuleGraph,
  type Reachability,
} from './module-graph.ts'

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

  await assertBuildExists(projectDir, distDir)

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
  const chunkAttributor = createChunkAttributor(distDir, index)

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
    const attribution = await chunkAttributor.attribute(chunk)
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
      chunkAttributor,
    })
    routes.push(route)
    for (const [file, bytes] of Object.entries(route.modules)) {
      allModules[file] = Math.max(allModules[file] ?? 0, bytes)
    }
    warnings.push(...route.warnings.map((w) => `${pattern}: ${w}`))
  }

  warnings.push(...chunkAttributor.warnings)

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
    coverage: computeCoverage(routes),
    sharedCauses: sharedCausesFor(routes, { packageNames: await readPackageNames(index) }),
    config: readBuildConfig({
      resolved: await readResolvedConfig(distDir),
      // Attribution needs maps; a build without them is a different kind of
      // build, not a build whose files happen to be smaller.
      sourceMaps: routes.some((route) => Object.keys(route.modules).length > 0),
    }),
    warnings,
  }
}

/**
 * Workspace package directory -> declared name, for labelling shared causes.
 *
 * Bounded work: a handful of `package.json` files that the source index already
 * found. Falling back to the directory would be honest but unhelpful - nobody
 * files a ticket against `packages/ui`, they file it against `@repo/ui`.
 */
async function readPackageNames(index: ProjectFileIndex): Promise<Record<string, string>> {
  const names: Record<string, string> = {}

  for (const file of index.files) {
    if (!file.endsWith('package.json')) continue
    const dir = file.slice(0, Math.max(0, file.length - '/package.json'.length))
    if (!dir) continue
    try {
      const raw = await readFile(join(index.root, file), 'utf8')
      const name = (JSON.parse(raw) as { name?: string }).name
      if (typeof name === 'string') names[dir] = name
    } catch {
      // A malformed or unreadable manifest just means this package goes
      // unlabelled; it is not a reason to fail the analysis.
    }
  }

  return names
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
  chunkAttributor: ChunkAttributor
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
    const attribution = await ctx.chunkAttributor.attribute(chunk)
    mergeAttribution(firstParty, attribution.firstParty)
    mergeAttribution(dependencies, attribution.dependencies)
    unattributed += attribution.unattributedBytes
    if (conventionOwned.has(chunk) || chunks.length === 1) routeBytes += attribution.bytes
    else sharedBytes += attribution.bytes
  }

  // Module graph and shell prediction need the page's source; without it the
  // route still reports byte totals, just no attribution or prediction.
  let dynamicReasons: string[] = []
  let clientBoundaries: ClientBoundary[] = []
  let barrels: BarrelCost[] = []
  let shell: RouteSnapshot['shell'] = null
  let routeRootComponent: string | null = null
  let conservativeModules = 0
  let causeGraph: ModuleGraph | null = null
  let causeReach: Reachability | null = null
  let layouts: string[] = []
  let routeConfig: Record<string, string | number | boolean> = {}

  if (pageFileAbs && pageFile) {
    const graph = await buildModuleGraph(pageFileAbs, ctx.index, ctx.resolver, ctx.overrides)

    layouts = layoutChainFor(pageFile, ctx.index)
    for (const layout of layouts) {
      const layoutAbs = join(ctx.index.root, layout)
      const layoutGraph = await buildModuleGraph(layoutAbs, ctx.index, ctx.resolver, ctx.overrides)
      for (const [file, node] of layoutGraph.nodes) if (!graph.nodes.has(file)) graph.nodes.set(file, node)
    }

    warnings.push(...graph.warnings)

    // Segment config from the page and every layout above it. A layout's
    // `revalidate` governs the pages beneath it, so reading only the page would
    // report a deliberate ISR window as an unexplained mode.
    routeConfig = { ...graph.nodes.get(pageFile)?.facts.routeConfig }
    for (const layout of layouts) {
      for (const [key, value] of Object.entries(graph.nodes.get(layout)?.facts.routeConfig ?? {})) {
        routeConfig[`${layout}:${key}`] = value
      }
    }

    const taint = propagateDynamicTaint(graph)

    // Module-level taint is the safe answer but blames imports the route never
    // calls. Narrowing withholds only the reasons it can prove unreachable from
    // the entry's own exports, and falls back to the module-level answer for any
    // module it could not follow - so this can lose a false positive, never a
    // real one.
    const reach = reachableTaint(graph, [pageFile, ...layouts])
    const moduleLevel = taint.get(pageFile) ?? []
    const narrowed = moduleLevel.filter((reason) => reach.reachable.has(baseReason(reason)))
    conservativeModules = reach.conservative.length

    dynamicReasons = [...new Set(narrowed.slice(0, 8))]
    causeGraph = graph
    causeReach = reach
    const attributed = Object.fromEntries(firstParty)
    clientBoundaries = boundaryCosts(graph, attributed)
    barrels = barrelCosts(graph, pageFile, attributed)
    routeRootComponent = graph.nodes.get(pageFile)?.facts.defaultExportName ?? null

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

  // A fully dynamic route has no shell artifact to name the missing component.
  // The build proves the route opted out, the taint graph names the call site,
  // and the route's default export is the component that introduced that work.
  // Record that evidence together so diff/CI can say `<CoursePage>` rather than
  // stopping at a service file. This is deliberately gated on the emitted mode;
  // module-level taint alone is too coarse to condemn a component.
  if (mode === 'DYNAMIC' && shell && routeRootComponent && dynamicReasons[0] && !shell.predictedHoles.some((hole) => hole.boundary === '<route>')) {
    shell.predictedHoles.unshift({ component: routeRootComponent, boundary: '<route>', reason: dynamicReasons[0] })
    shell.predictedStatic = shell.predictedStatic.filter((name) => name !== routeRootComponent)
  }

  const causes: CauseChain[] = []
  if (causeGraph && causeReach && pageFile && !isRouteHandler) {
    // The emitted mode is what makes a dynamic chain `verified` rather than
    // `inferred`: source can show the call, only the build can show that Next
    // acted on it.
    const confirmedByArtifact = mode === 'DYNAMIC' || mode === 'PARTIALLY_STATIC'

    for (const reason of dynamicReasons) {
      const path = causeReach.reachable.get(baseReason(reason))
      if (!path) continue
      causes.push(
        buildCauseChain({
          route: ctx.pattern,
          graph: causeGraph,
          entryFile: pageFile,
          reason,
          path,
          confirmedByArtifact,
        }),
      )
    }

    // Only the modules big enough to be worth a chain. Explaining a 300-byte
    // helper buries the barrel that actually cost the route its budget.
    const heaviest = [...firstParty]
      .filter(([, bytes]) => bytes >= BYTES_WORTH_EXPLAINING)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_BYTES_CAUSES)

    for (const [file, bytes] of heaviest) {
      causes.push(buildBytesCause({ route: ctx.pattern, graph: causeGraph, entryFile: pageFile, file, bytes }))
    }
  }

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
    causes,
    clientBoundaries,
    barrels,
    layouts,
    // Chunks this route did not bring in on its own. Recorded by name so the
    // blast radius can group routes that load the same one.
    sharedChunks: chunks.filter((chunk) => !conventionOwned.has(chunk) && chunks.length > 1),
    config: routeConfig,
    shell,
    warnings,
    conservativeModules,
  }
}

/** A chain costs a reader attention; below this the answer is not worth one. */
const BYTES_WORTH_EXPLAINING = 4096
const MAX_BYTES_CAUSES = 5

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

async function assertBuildExists(projectDir: string, distDir: string): Promise<void> {
  try {
    await stat(join(distDir, 'app-path-routes-manifest.json'))
  } catch {
    throw new Error(
      [
        `No Next.js production build found at ${distDir}.`,
        `Run \`next build\` in the app directory (${projectDir}), then rerun crust.`,
        'In a monorepo, run crust from the app folder (for example, `apps/web`) or pass `--cwd apps/web`.',
        'If Next.js writes somewhere other than `.next`, pass `--dist-dir <directory>`.',
        'crust measures production builds only; development output is not valid performance evidence.',
      ].join('\n'),
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
