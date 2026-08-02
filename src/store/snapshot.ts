import type { Bundler, RenderingMode } from '../adapters/types.ts'

/**
 * Bump on any change to the shapes below. A stored snapshot outlives the tool
 * version that wrote it, and silently reinterpreting old records under new
 * semantics is how a history feature starts lying about the past.
 */
export const SCHEMA_VERSION = 1

export interface Snapshot {
  schemaVersion: number
  toolVersion: string
  buildId: string
  createdAt: string

  gitSha: string | null
  /** Author date — survives rebase, unlike commit date. */
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
   * from the local store — oldest first. The analyzer never fills this in; a
   * snapshot describes one build, and history is the store's concern.
   */
  history?: Record<string, { bytes: number[]; shell: (number | null)[] }>
  /** Content-addressed module sizes, deduped across snapshots at write time. */
  modules: Record<string, number>
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
  clientBoundaryRoots: string[]
  shell: ShellSnapshot | null
  warnings: string[]
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
