import type { Coverage, Snapshot } from '../store/snapshot.ts'

/**
 * The rules that keep a model from turning deterministic evidence back into a
 * guess. They are enforced here rather than remembered per tool, because "every
 * response carries coverage" is only true if it is impossible to forget.
 *
 * Three of the plan's constraints live in this file:
 *
 * - *Bounded responses.* A tool that floods the context window makes the agent
 *   worse, not better. Everything list-shaped goes through `cap`, and a capped
 *   list says so - a silently truncated list reads as a complete one.
 * - *Coverage travels.* Any answer carrying byte attribution carries the share
 *   of the build those bytes came from. "48.2 kB from date-fns" with no "94%
 *   attributed" beside it invites more confidence than the evidence supports.
 * - *`unknown` is returned, never omitted.* An absent field reads as "no
 *   problem" to a model, so a missing answer is a value with a reason.
 */

/** Routes, causes, modules or dependencies named before a list becomes a count. */
export const CAP = {
  builds: 20,
  routes: 10,
  modules: 10,
  dependencies: 10,
  boundaries: 10,
  barrels: 5,
  dragged: 5,
  causes: 10,
  links: 12,
  chains: 5,
  findings: 10,
  history: 30,
  warnings: 5,
  patterns: 25,
} as const

export interface Capped<T> {
  items: T[]
  /** Total before the cap. Equal to `items.length` when nothing was dropped. */
  total: number
  /** True when the list is a sample. Present on every capped list, not just the truncated ones. */
  truncated: boolean
}

export function cap<T>(items: T[], limit: number): Capped<T> {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit }
}

/**
 * A capped list of already-mapped values, where mapping the dropped tail would
 * be wasted work.
 */
export function capMap<T, U>(items: T[], limit: number, map: (item: T) => U): Capped<U> {
  return { items: items.slice(0, limit).map(map), total: items.length, truncated: items.length > limit }
}

export interface CoverageReport {
  /** Share of client bytes crust could attribute to a source file, 0..100, or `unknown`. */
  attributedPercent: number | 'unknown'
  /** The denominator, so a reader can recompute the percentage rather than trust it. */
  clientBytesTotal: number
  clientBytesAttributed: number
  routesClassified: number
  routesTotal: number
  /** `coverage.confidence` as crust computed it, 0..1. */
  confidence: number
  /** Modules taken at file granularity, which is why some cause chains stop early. */
  conservativeModules: number
  unresolvedRelationships: number
  /** Set when the numbers above are weak enough that an empty finding list means "not measured". */
  caveat: string | null
}

/** Below this share of client bytes, absence of evidence is not evidence of absence. */
const WEAK_ATTRIBUTION = 0.5

/**
 * The coverage block attached to every answer that reports bytes.
 *
 * `attributedPercent` is `unknown` rather than 100 when there were no client
 * bytes to attribute: a percentage with no denominator is exactly the kind of
 * confident-looking number this tool exists not to produce.
 */
export function coverageReport(coverage: Coverage): CoverageReport {
  const { clientBytesTotal, clientBytesAttributed } = coverage
  const ratio = clientBytesTotal > 0 ? clientBytesAttributed / clientBytesTotal : null

  return {
    attributedPercent: ratio === null ? 'unknown' : Math.round(ratio * 1000) / 10,
    clientBytesTotal,
    clientBytesAttributed,
    routesClassified: coverage.routesClassified,
    routesTotal: coverage.routesTotal,
    confidence: coverage.confidence,
    conservativeModules: coverage.conservativeModules,
    unresolvedRelationships: coverage.unresolvedRelationships,
    caveat:
      ratio === null
        ? 'No client JavaScript was attributed in this build, so byte-level findings cannot be ranked. Absence of a finding is not evidence there is none.'
        : ratio < WEAK_ATTRIBUTION
          ? `Only ${Math.round(ratio * 100)}% of client bytes are attributed to a source file. An empty or short finding list here means "not measured", not "nothing wrong".`
          : null,
  }
}

/** How a build is named in every answer, so any claim can be checked with the CLI. */
export interface Citation {
  buildId: string
  gitSha: string | null
  branch: string | null
  createdAt: string
  nextVersion: string
  bundler: string
  /** True when the tree had uncommitted changes, which makes the build unreproducible. */
  dirty: boolean
}

export function cite(snapshot: Snapshot): Citation {
  return {
    buildId: snapshot.buildId,
    gitSha: snapshot.gitSha,
    branch: snapshot.branch,
    createdAt: snapshot.createdAt,
    nextVersion: snapshot.nextVersion,
    bundler: snapshot.bundler,
    dirty: snapshot.dirty,
  }
}

/**
 * A refusal, in the shape a model reads correctly.
 *
 * `error` alone gets summarised away as "the tool didn't work"; the fix belongs
 * in the payload so the next tool call is the right one. `ok: false` is always
 * present so a consumer never has to infer failure from a missing field.
 */
export interface Refusal {
  ok: false
  error: string
  /** What the caller should do instead. Never null: a refusal with no next step is noise. */
  remedy: string
}

export function refuse(error: string, remedy: string): Refusal {
  return { ok: false, error, remedy }
}
