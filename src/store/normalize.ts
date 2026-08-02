import { computeCoverage } from '../analyze/coverage.ts'
import type { RouteSnapshot, Snapshot } from './snapshot.ts'

/**
 * Bring a snapshot read from disk up to the current shape.
 *
 * A stored snapshot outlives the version that wrote it, but the moment it comes
 * back from `JSON.parse` the type says `Snapshot` - which is a lie for every
 * field added since. Reading `base.config.cacheComponents` off a v3 record threw
 * `TypeError: Cannot read properties of undefined`, and the schema-version guard
 * that should have caught it ran two lines too late.
 *
 * So the boundary normalises once. One place that knows the current shape,
 * applied to everything read from the store, instead of an optional chain at
 * every use site that has to be remembered again on the next schema bump.
 *
 * Absent stays absent: the new fields default to empty rather than to a guess,
 * and `schemaVersion` is left exactly as written so the diff can still refuse to
 * compare across versions.
 */
export function normalizeSnapshot(raw: Snapshot): Snapshot {
  const routes = (raw.routes ?? []).map(normalizeRoute)

  return {
    ...raw,
    routes,
    modules: raw.modules ?? {},
    sharedCauses: raw.sharedCauses ?? [],
    // Left null rather than defaulted. Substituting `{cacheComponents: false,
    // sourceMaps: false, experimental: {}}` made the diff announce "browser
    // source maps turned on" and four experimental flag changes against a v1
    // baseline - none of which happened. The baseline recorded no config; that
    // is unknown, not false.
    config: raw.config ?? null,
    // Derived, not defaulted. Every input to coverage - rendering modes, shells,
    // attributed and unattributed bytes - is present in older records too, so
    // computing it reports what that build actually covered rather than showing
    // a perfectly good snapshot at 0% confidence.
    coverage: raw.coverage ?? computeCoverage(routes),
    warnings: raw.warnings ?? [],
  }
}

/** v3 and earlier named this `clientBoundaryRoots` and carried no costs. */
type LegacyRoute = RouteSnapshot & { clientBoundaryRoots?: string[] }

function normalizeRoute(raw: LegacyRoute): RouteSnapshot {
  const { clientBoundaryRoots, ...route } = raw

  return {
    ...route,
    modules: route.modules ?? {},
    dependencies: route.dependencies ?? {},
    dynamicReasons: route.dynamicReasons ?? [],
    causes: route.causes ?? [],
    // Carrying the files forward at zero bytes keeps what that build did know.
    // Claiming a size for them would be the invention this function avoids.
    clientBoundaries:
      route.clientBoundaries ?? (clientBoundaryRoots ?? []).map((file) => ({ file, component: null, bytes: 0 })),
    barrels: route.barrels ?? [],
    layouts: route.layouts ?? [],
    sharedChunks: route.sharedChunks ?? [],
    config: route.config ?? {},
    shell: route.shell ?? null,
    warnings: route.warnings ?? [],
    conservativeModules: route.conservativeModules ?? 0,
  }
}
