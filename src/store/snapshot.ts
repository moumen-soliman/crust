import type { Bundler, RenderingMode } from '../adapters/types.ts'

/**
 * Bump on any change to the shapes below. A stored snapshot outlives the tool
 * version that wrote it, and silently reinterpreting old records under new
 * semantics is how a history feature starts lying about the past.
 */
export const SCHEMA_VERSION = 4

export interface Snapshot {
  schemaVersion: number
  toolVersion: string
  buildId: string
  createdAt: string

  gitSha: string | null
  /** Author date - survives rebase, unlike commit date. */
  committedAt: string | null
  parentSha: string | null
  branch: string | null
  dirty: boolean

  nextVersion: string
  nodeMajor: number
  bundler: Bundler
  /** Hash of the route table plus module set; re-links history orphaned by squash merges. */
  sourceSignature: string

  routes: RouteSnapshot[]
  /**
   * Optional per-route trend data, embedded by `crust report` / `crust manifest`
   * from the local store - oldest first. The analyzer never fills this in; a
   * snapshot describes one build, and history is the store's concern.
   */
  history?: Record<string, { bytes: number[]; shell: (number | null)[] }>
  /** Content-addressed module sizes, deduped across snapshots at write time. */
  modules: Record<string, number>
  /** How much of this build the analysis could account for. */
  coverage: Coverage
  /** Root causes that affect more than one route, worst first. */
  sharedCauses: SharedCause[]
  /**
   * Build and framework configuration, for separating config moves from code
   * moves. Null on a snapshot written before crust recorded it - which is not
   * the same as a build that had none, and must not be diffed as though it were.
   */
  config: BuildConfig | null
  warnings: string[]
}

export interface RouteSnapshot {
  /** Trend key: the page file path, not the URL pattern. Patterns change in refactors. */
  id: string
  pattern: string
  filePath: string | null
  renderingMode: RenderingMode | 'unknown'
  renderingModeReason: string | null

  /** Client JS a first visit to this route downloads. */
  firstLoadBytes: number
  /** Chunks unique to this route. */
  routeBytes: number
  /** Chunks this route shares with others. */
  sharedBytes: number
  /** Bytes we could not attribute to any source. */
  unattributedBytes: number

  /** Workspace-relative source file -> attributed bytes. */
  modules: Record<string, number>
  /** Package name -> attributed bytes. */
  dependencies: Record<string, number>

  /** Why this route is dynamic, if it is. Empty when static. */
  dynamicReasons: string[]
  /**
   * The same conclusions with their source relationships intact: route ->
   * component -> import chain -> call site. `dynamicReasons` stays because the
   * terminal summary and the diff both want one line; this is what the JSON and
   * the HTML report expand into.
   */
  causes: CauseChain[]
  /**
   * Where server rendering stops and the browser takes over, with what each
   * boundary costs. A route's client JS is the sum of its boundaries plus the
   * framework, so this is the level at which the cost is anybody's to change.
   */
  clientBoundaries: ClientBoundary[]
  /**
   * Barrels this route imports, and what each one drags in that the route can
   * never render. This is the cost of the import style rather than of any
   * component, and it is invisible at file granularity because every dragged
   * file looks like an ordinary dependency of the page.
   */
  barrels: BarrelCost[]
  /** The layout chain above this route, outermost first. */
  layouts: string[]
  /** Chunks this route shares with at least one other route. */
  sharedChunks: string[]
  /** Route segment config the source declares - `dynamic`, `revalidate`, `runtime`. */
  config: Record<string, string | number | boolean>
  shell: ShellSnapshot | null
  warnings: string[]
  /**
   * Modules on this route whose taint could not be narrowed below file
   * granularity. Feeds coverage, and explains why a cause chain stops early.
   */
  conservativeModules: number
}

/**
 * How strongly crust can support a conclusion.
 *
 * `verified` - an emitted build artifact agrees.
 * `inferred` - source relationships support it, no artifact confirms it.
 * `unknown`  - the chain has a gap, and guessing across it is refused.
 */
export type Evidence = 'verified' | 'inferred' | 'unknown'

export interface CauseChain {
  route: string
  /** Where the chain starts - the page or layout Next called. */
  entryFile: string
  /** Nearest rendered component the evidence supports, if any. */
  component: string | null
  /** Hops from the entry to the site, entry first. */
  links: CauseLink[]
  /** `packages/core/src/services/index.ts:29`, when the site has a position. */
  site: string | null
  /** `uncached fetch`, `cookies()`, `barrel import @repo/ui/icons`. */
  detail: string
  evidence: Evidence
  /** The segment that could not be completed, when the chain is partial. */
  unresolved: string | null
}

export interface ClientBoundary {
  /** The `'use client'` file with no client ancestor - where the boundary starts. */
  file: string
  /** Its default-exported component, when the source names one. */
  component: string | null
  /** Attributed bytes of everything reachable from here, this boundary included. */
  bytes: number
}

export interface BarrelCost {
  /** The barrel module - declares nothing, forwards other modules' exports. */
  file: string
  /** Attributed bytes of the modules only this barrel brings in. */
  bytes: number
  /**
   * Modules that reach this route through the barrel and through nothing else.
   * Proven by re-walking the import graph with the barrel removed, so this is
   * what deleting the barrel import would actually save.
   */
  dragged: string[]
}

/**
 * One root cause with every route it affects, instead of the same finding
 * repeated per route.
 *
 * A shared layout, provider or barrel is the single most common way a one-line
 * change becomes a twenty-route regression, and per-route reporting buries that
 * under twenty identical entries that each look small.
 */
export interface SharedCause {
  kind: 'layout' | 'client-boundary' | 'package' | 'barrel' | 'shared-chunk' | 'call-site'
  /** Stable identity - the file, package name, chunk or call site. */
  key: string
  /** How it reads in a report: `<RootProvider>`, `@repo/ui/icons`. */
  label: string
  /** Route patterns affected, sorted. */
  routes: string[]
  /** What it costs a single route, when the cost is measurable. */
  bytesPerRoute: number | null
  /** `bytesPerRoute` summed over the affected routes. */
  bytesTotal: number | null
  /** The component carrying it, when the evidence names one. */
  component: string | null
  /** The package or module one level up, when the evidence names one. */
  introducedBy: string | null
  evidence: Evidence
}

/**
 * Build and framework configuration that materially changes what gets emitted.
 *
 * Kept apart from application source so a diff can say "rendering moved because
 * Cache Components was switched on", rather than reporting twenty routes as
 * regressions authored by whoever flipped the flag.
 */
export interface BuildConfig {
  cacheComponents: boolean
  /** `experimental.*` keys the emitted output actually depends on. */
  experimental: Record<string, string | number | boolean>
  /** Whether the build emitted browser source maps, which attribution needs. */
  sourceMaps: boolean
}

export interface CauseLink {
  file: string
  /** The binding written at this hop - the local name, as the source spells it. */
  binding: string
  via: 'entry' | 'module-scope' | 'local' | 'import' | 'namespace' | 'opaque'
  /** A module that declares nothing and only forwards other modules' exports. */
  barrel: boolean
  /** This binding is a component the source declares, so it renders as `<Name>`. */
  component: boolean
}

/**
 * What share of the build crust could actually account for.
 *
 * Every field is a count taken from the analysis, never a judgement: a reader
 * who disagrees with how `confidence` weighs them can recompute it from the
 * parts. That is the point - a single score with no visible denominator is the
 * thing this is designed not to be.
 */
export interface Coverage {
  routesTotal: number
  /** Routes with a rendering mode that is not `unknown`. */
  routesClassified: number
  /** Routes whose build emitted a shell we could read. */
  shellsEmitted: number
  shellsMeasured: number
  clientBytesTotal: number
  clientBytesAttributed: number
  /** Components the predictor refused to classify, plus unfollowable imports. */
  unresolvedRelationships: number
  /** Modules whose taint had to be taken at module granularity. */
  conservativeModules: number
  /** Derived from the counts above, 0..1. */
  confidence: number
}

export interface ShellSnapshot {
  /** Layer 1: components predicted to survive into the static shell. */
  predictedStatic: string[]
  /** Layer 1: components predicted to be postponed, with the reason. */
  predictedHoles: PredictedHole[]
  /** Layer 2: what the build actually produced, when a shell was emitted. */
  actual: ActualShell | null
  /** Agreement between layers 1 and 2, 0..1, or null when unverifiable. */
  agreement: number | null
  /** Components the predictor refused to classify. */
  unknown: string[]
}

export interface PredictedHole {
  /** The component that fell out of the shell. */
  component: string
  /** Where the boundary is. */
  boundary: string
  /** The call that made it dynamic, e.g. `cookies() at app/dashboard/page.tsx:18`. */
  reason: string
}

export interface ActualShell {
  /** Path of the HTML that was measured, relative to distDir. */
  htmlPath: string
  bytes: number
  /** Number of `<!--$?-->` pending boundaries in the shell. */
  holes: number
  /** Boundary ids in document order, e.g. `B:0`. */
  boundaryIds: string[]
  /** Fraction of the rendered route that is static, 0..1. */
  shellRatio: number
}

export interface Budgets {
  /** Per-route first-load JS ceiling, in bytes. */
  firstLoadBytes?: Record<string, number>
  /** Global ceiling applied to any route without a specific entry. */
  defaultFirstLoadBytes?: number
  /** Maximum tolerated growth versus the baseline, as a fraction (0.1 = 10%). */
  maxGrowth?: number
  /** Minimum tolerated shell ratio per route, 0..1. */
  minShellRatio?: Record<string, number>
  defaultMinShellRatio?: number
  /**
   * Route patterns exempt from the zero-config regression rules (rendering mode,
   * caching, shell disappearance). Those rules need no threshold to be meaningful
   * and so are on by default; this is the escape hatch for a downgrade that was
   * the point of the PR, and it is a list of routes rather than a global switch
   * so that exempting one page cannot quietly exempt the rest of the app.
   */
  allowRegression?: string[]
}
