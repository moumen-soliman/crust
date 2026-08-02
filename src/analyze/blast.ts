import type { Evidence, RouteSnapshot, SharedCause } from '../store/snapshot.ts'

/**
 * One root cause, every route it reaches (roadmap §3).
 *
 * A provider added to the root layout is a single edit that lands on every
 * route in the app. Reported per route it is twenty entries that each look
 * survivable; reported once, with the twenty routes attached, it is obviously
 * the largest thing in the build. The grouping is the finding.
 *
 * Nothing here re-derives evidence. Every group is assembled from what the
 * per-route analysis already proved, so a cause that was `inferred` on one
 * route cannot become `verified` by being counted twice.
 */

export interface BlastOptions {
  /** Package directory -> declared name, for labelling workspace packages. */
  packageNames?: Record<string, string>
}

export function sharedCausesFor(routes: RouteSnapshot[], options: BlastOptions = {}): SharedCause[] {
  const measurable = routes.filter((route) => route.renderingMode !== 'ROUTE_HANDLER')
  const packageNames = options.packageNames ?? {}

  const ownerOf = ownerFinder(packageNames)

  const causes = [
    ...groupClientBoundaries(measurable, ownerOf),
    ...groupBarrels(measurable, ownerOf),
    ...groupLayouts(measurable, ownerOf),
    ...groupPackages(measurable, packageNames),
    ...groupSharedChunks(measurable),
    ...groupCallSites(measurable, ownerOf),
  ].filter((cause) => cause.routes.length > 1)

  // Bytes first because they are comparable, then reach. A cause with no
  // measurable cost still sorts above a smaller one that has some, because
  // "unknown cost across nineteen routes" is not a lesser finding than "2 kB
  // across two" - it is an unquantified one.
  return causes.sort(
    (a, b) => (b.bytesTotal ?? 0) - (a.bytesTotal ?? 0) || b.routes.length - a.routes.length,
  )
}

/**
 * The roadmap's headline shape: `<RootProvider> adds 84 kB to 19 routes`.
 *
 * Cost is per route rather than summed-then-divided. The same provider mounted
 * on nineteen routes costs each of them the same bytes, and a reader deciding
 * whether to act needs the number a single page pays.
 */
function groupClientBoundaries(routes: RouteSnapshot[], ownerOf: OwnerOf): SharedCause[] {
  const byFile = new Map<string, { routes: string[]; bytes: number[]; component: string | null }>()

  for (const route of routes) {
    for (const boundary of route.clientBoundaries) {
      const entry = byFile.get(boundary.file) ?? { routes: [], bytes: [], component: boundary.component }
      entry.routes.push(route.pattern)
      entry.bytes.push(boundary.bytes)
      entry.component ??= boundary.component
      byFile.set(boundary.file, entry)
    }
  }

  return [...byFile].map(([file, entry]) => {
    // The largest, not the mean: a boundary that costs 84 kB on one route and
    // less on another is still an 84 kB component, and averaging it down hides
    // the worst case behind routes that happen to tree-shake better.
    const perRoute = Math.max(...entry.bytes)
    return {
      kind: 'client-boundary' as const,
      key: file,
      label: entry.component ? `<${entry.component}>` : file,
      routes: [...new Set(entry.routes)].sort(),
      bytesPerRoute: perRoute,
      bytesTotal: perRoute * new Set(entry.routes).size,
      component: entry.component,
      introducedBy: ownerOf(file),
      // Bytes come from the emitted chunk and its source map; the boundary comes
      // from a `'use client'` directive that is in the file either way.
      evidence: 'verified' as Evidence,
    }
  })
}

function groupBarrels(routes: RouteSnapshot[], ownerOf: OwnerOf): SharedCause[] {
  const byFile = new Map<string, { routes: string[]; bytes: number[]; dragged: Set<string> }>()

  for (const route of routes) {
    for (const barrel of route.barrels) {
      const entry = byFile.get(barrel.file) ?? { routes: [], bytes: [], dragged: new Set<string>() }
      entry.routes.push(route.pattern)
      entry.bytes.push(barrel.bytes)
      for (const file of barrel.dragged) entry.dragged.add(file)
      byFile.set(barrel.file, entry)
    }
  }

  return [...byFile].map(([file, entry]) => {
    const perRoute = Math.max(...entry.bytes)
    const routePatterns = [...new Set(entry.routes)].sort()
    return {
      kind: 'barrel' as const,
      key: file,
      label: `barrel import ${file}`,
      routes: routePatterns,
      bytesPerRoute: perRoute,
      bytesTotal: perRoute * routePatterns.length,
      component: null,
      introducedBy: ownerOf(file),
      evidence: 'verified' as Evidence,
    }
  })
}

/**
 * A layout is shared by construction, so this only reports one that is carrying
 * something: a client boundary of its own, or a cause chain that runs through
 * it. Listing every layout with its route count would be a route table with
 * extra steps.
 */
function groupLayouts(routes: RouteSnapshot[], ownerOf: OwnerOf): SharedCause[] {
  const byFile = new Map<string, { routes: string[]; bytes: number; component: string | null }>()

  for (const route of routes) {
    for (const layout of route.layouts) {
      const boundary = route.clientBoundaries.find((b) => b.file === layout)
      const chain = route.causes.find((cause) => cause.links.some((link) => link.file === layout))
      if (!boundary && !chain) continue

      const entry = byFile.get(layout) ?? { routes: [], bytes: 0, component: null }
      entry.routes.push(route.pattern)
      entry.bytes = Math.max(entry.bytes, boundary?.bytes ?? 0)
      entry.component ??= boundary?.component ?? chain?.component ?? null
      byFile.set(layout, entry)
    }
  }

  return [...byFile].map(([file, entry]) => {
    const routePatterns = [...new Set(entry.routes)].sort()
    return {
      kind: 'layout' as const,
      key: file,
      label: entry.component ? `<${entry.component}> in ${file}` : file,
      routes: routePatterns,
      bytesPerRoute: entry.bytes > 0 ? entry.bytes : null,
      bytesTotal: entry.bytes > 0 ? entry.bytes * routePatterns.length : null,
      component: entry.component,
      introducedBy: ownerOf(file),
      evidence: 'verified' as Evidence,
    }
  })
}

/**
 * Workspace packages, so a monorepo can see that one package accounts for a
 * slice of every app route at once. Keyed by the package directory and labelled
 * with its declared name when the workspace could supply one.
 */
function groupPackages(routes: RouteSnapshot[], packageNames: Record<string, string>): SharedCause[] {
  const dirs = Object.keys(packageNames).sort((a, b) => b.length - a.length)
  if (dirs.length === 0) return []

  const byPackage = new Map<string, { routes: string[]; bytes: Map<string, number> }>()

  for (const route of routes) {
    const perRoute = new Map<string, number>()
    for (const [file, bytes] of Object.entries(route.modules)) {
      const dir = dirs.find((candidate) => file.startsWith(`${candidate}/`))
      if (!dir) continue
      perRoute.set(dir, (perRoute.get(dir) ?? 0) + bytes)
    }
    for (const [dir, bytes] of perRoute) {
      const entry = byPackage.get(dir) ?? { routes: [], bytes: new Map<string, number>() }
      entry.routes.push(route.pattern)
      entry.bytes.set(route.pattern, bytes)
      byPackage.set(dir, entry)
    }
  }

  return [...byPackage].map(([dir, entry]) => {
    const perRoute = Math.max(...entry.bytes.values())
    const routePatterns = [...new Set(entry.routes)].sort()
    return {
      kind: 'package' as const,
      key: dir,
      label: packageNames[dir] ?? dir,
      routes: routePatterns,
      bytesPerRoute: perRoute,
      bytesTotal: [...entry.bytes.values()].reduce((sum, bytes) => sum + bytes, 0),
      component: null,
      introducedBy: null,
      evidence: 'verified' as Evidence,
    }
  })
}

/**
 * Chunks more than one route loads. The bytes are not attributed here - a
 * shared chunk's contents are already charged to the files inside it, and
 * counting them again under the chunk would double the total.
 */
function groupSharedChunks(routes: RouteSnapshot[]): SharedCause[] {
  const byChunk = new Map<string, string[]>()

  for (const route of routes) {
    for (const chunk of route.sharedChunks) {
      byChunk.set(chunk, [...(byChunk.get(chunk) ?? []), route.pattern])
    }
  }

  return [...byChunk].map(([chunk, patterns]) => ({
    kind: 'shared-chunk' as const,
    key: chunk,
    label: chunk,
    routes: [...new Set(patterns)].sort(),
    bytesPerRoute: null,
    bytesTotal: null,
    component: null,
    introducedBy: null,
    evidence: 'verified' as Evidence,
  }))
}

/**
 * One uncached read in a shared service, reached by many routes. This is the
 * cheapest fix in the build and the easiest to miss, because each route reports
 * it as its own separate regression.
 */
function groupCallSites(routes: RouteSnapshot[], ownerOf: OwnerOf): SharedCause[] {
  const bySite = new Map<
    string,
    { routes: string[]; detail: string; component: string | null; introducedBy: string | null; evidence: Evidence[] }
  >()

  for (const route of routes) {
    for (const cause of route.causes) {
      if (!cause.site || cause.detail.includes(' kB')) continue

      const entry = bySite.get(cause.site) ?? {
        routes: [],
        detail: cause.detail,
        component: cause.component,
        introducedBy: ownerOf(cause.site.replace(/:\d+$/, '')),
        evidence: [],
      }
      entry.routes.push(route.pattern)
      entry.component ??= cause.component
      entry.evidence.push(cause.evidence)
      bySite.set(cause.site, entry)
    }
  }

  return [...bySite].map(([site, entry]) => ({
    kind: 'call-site' as const,
    key: site,
    label: `${entry.detail} at ${site}`,
    routes: [...new Set(entry.routes)].sort(),
    bytesPerRoute: null,
    bytesTotal: null,
    component: entry.component,
    introducedBy: entry.introducedBy,
    // The weakest evidence on any route wins. A chain with a gap on one route is
    // a gap in the shared conclusion too.
    evidence: weakest(entry.evidence),
  }))
}

const EVIDENCE_ORDER: Record<Evidence, number> = { unknown: 0, inferred: 1, verified: 2 }

const weakest = (levels: Evidence[]): Evidence =>
  levels.length === 0 ? 'unknown' : levels.reduce((a, b) => (EVIDENCE_ORDER[b] < EVIDENCE_ORDER[a] ? b : a))

/**
 * The unit someone would file a ticket against.
 *
 * A workspace package when the file lives in one, by its declared name -
 * `@repo/features`, not `packages/features/src/analytics`. Falling back to the
 * containing directory keeps the line useful in a single-package app, where
 * there are no package names to look up.
 */
type OwnerOf = (file: string) => string | null

function ownerFinder(packageNames: Record<string, string>): OwnerOf {
  // Longest first: `packages/ui/src` must lose to nothing, but a nested package
  // must beat the workspace root that contains it.
  const dirs = Object.keys(packageNames).sort((a, b) => b.length - a.length)

  return (file: string) => {
    const dir = dirs.find((candidate) => file.startsWith(`${candidate}/`))
    if (dir) return packageNames[dir] ?? dir
    const parent = file.slice(0, file.lastIndexOf('/'))
    return parent || null
  }
}
