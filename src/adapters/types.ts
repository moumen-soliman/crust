export type Bundler = 'webpack' | 'turbopack'

/**
 * Everything the tool can't determine is reported as `unknown` and never guessed.
 * A predictor that guesses wrong destroys trust in the whole tool (plan §3).
 */
export type Known<T> = { known: true; value: T } | { known: false; reason: string }

export const known = <T>(value: T): Known<T> => ({ known: true, value })
export const unknown = <T>(reason: string): Known<T> => ({ known: false, reason })

export interface ChunkRef {
  /** Path relative to `.next/`, e.g. `static/chunks/app/page-4f2a.js`. */
  file: string
  bytes: number
  /** True when the chunk is shared by more than one route. */
  shared: boolean
}

export interface RouteEntry {
  /** Stable trend key — file path, not URL pattern (plan §6). */
  id: string
  pattern: string
  filePath: string | null
  kind: 'page' | 'route' | 'layout' | 'not-found'
  /** As reported by the build, not inferred. */
  renderingMode: Known<RenderingMode>
  clientChunks: ChunkRef[]
  /** First-load JS: this route's chunks plus the shared runtime. */
  firstLoadBytes: number
}

export type RenderingMode = 'STATIC' | 'PARTIALLY_STATIC' | 'DYNAMIC' | 'ISR' | 'ROUTE_HANDLER'

export interface ShellArtifact {
  routeId: string
  /** Path to the prerendered fallback HTML, when the build emitted one. */
  htmlPath: string | null
  /**
   * Present but never parsed. The docs are explicit that reading or altering
   * postponed state produces incorrect output; the shell HTML is the readable
   * artifact and it already contains each fallback where its hole is (plan §4).
   */
  hasPostponedState: boolean
}

export interface BuildAnalysis {
  bundler: Bundler
  nextVersion: string
  /** Directory the artifacts were read from, absolute. */
  distDir: string
  routes: RouteEntry[]
  shells: ShellArtifact[]
  sharedChunks: ChunkRef[]
  /** Non-fatal gaps: each one is a feature that degraded rather than a crash (R3). */
  warnings: string[]
}

/**
 * One interface, two implementations, from the first commit — never an inline
 * `if (bundler === 'turbopack')` branch (R2). Feature asymmetry between the two
 * is expected and gets documented, not hidden.
 */
export interface BundlerAdapter {
  readonly bundler: Bundler

  /** Cheap check: does this dist dir look like it came from this bundler? */
  detect(distDir: string): Promise<boolean>

  /** Read whatever the build emitted. Missing optional artifacts become warnings. */
  analyze(ctx: AdapterContext): Promise<BuildAnalysis>

  /**
   * Whether this bundler supports the stamping transform (R4). Turbopack has no
   * custom loader equivalent, so this is expected to be false there for now, and
   * attribution falls back to source maps only.
   */
  readonly supportsStamping: boolean
}

export interface AdapterContext {
  /** Project root, where next.config lives. */
  cwd: string
  distDir: string
  nextVersion: string
}
