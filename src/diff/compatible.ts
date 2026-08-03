import type { Snapshot } from '../store/snapshot.ts'

/**
 * Whether two builds can be compared at all.
 *
 * The three framework-level facts only: across a snapshot schema, a bundler swap
 * or a Next major, every number moves for reasons no pull request caused. Route
 * identity is deliberately not part of this - a baseline resolved from git history
 * is the right baseline even for a branch that renamed every page.
 */
export function comparableBuilds(a: Snapshot, b: Snapshot): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.bundler === b.bundler &&
    a.nextVersion.split('.')[0] === b.nextVersion.split('.')[0]
  )
}

/** Latest local build that diff can compare without inventing framework noise. */
export function latestCompatibleBaseline(head: Snapshot, candidates: Snapshot[]): Snapshot | null {
  const routeIds = new Set(head.routes.map((route) => route.id))
  return candidates.find((candidate) =>
    candidate.buildId !== head.buildId &&
    comparableBuilds(candidate, head) &&
    candidate.routes.some((route) => routeIds.has(route.id)),
  ) ?? null
}
