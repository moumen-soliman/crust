import type { Snapshot } from '../store/snapshot.ts'

/** Latest local build that diff can compare without inventing framework noise. */
export function latestCompatibleBaseline(head: Snapshot, candidates: Snapshot[]): Snapshot | null {
  const routeIds = new Set(head.routes.map((route) => route.id))
  const nextMajor = head.nextVersion.split('.')[0]
  return candidates.find((candidate) =>
    candidate.buildId !== head.buildId &&
    candidate.schemaVersion === head.schemaVersion &&
    candidate.bundler === head.bundler &&
    candidate.nextVersion.split('.')[0] === nextMajor &&
    candidate.routes.some((route) => routeIds.has(route.id)),
  ) ?? null
}
