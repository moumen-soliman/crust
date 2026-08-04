import { isBytesChain } from '../analyze/cause.ts'
import { compareConfig, type ConfigChange } from '../analyze/config.ts'
import type { CauseChain, RouteSnapshot, Snapshot } from '../store/snapshot.ts'
import { compareModes, revalidateSeconds, type ModeChange } from './mode.ts'
import { parseReason, reasonKey, shortReason } from './reason.ts'

export interface RouteDelta {
  pattern: string
  id: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  /**
   * Whether the change is worth a reviewer's attention and in which direction.
   * `status` answers "did anything move"; this answers "should anyone care",
   * which is what decides whether the route appears in the PR comment at all.
   */
  severity: 'regression' | 'improvement' | 'neutral'

  firstLoadBefore: number
  firstLoadAfter: number
  firstLoadDelta: number

  shellRatioBefore: number | null
  shellRatioAfter: number | null
  shellRatioDelta: number | null

  renderingModeBefore: string | null
  renderingModeAfter: string | null
  /** Set only when the mode actually moved, with the direction on the staticness scale. */
  modeChange: ModeChange | null
  /** Set only when something about caching moved. */
  cacheChange: CacheChange | null

  /** Modules that grew, shrank, appeared or vanished - largest absolute change first. */
  modules: ModuleDelta[]
  /** Holes that appeared since the baseline, with the reason the build gave. */
  newHoles: { component: string; reason: string }[]
  /**
   * The one thing to print when there is room for one line. Null when nothing
   * changed; `kind: 'unknown'` when something changed and we cannot say what.
   */
  cause: Cause | null
  /**
   * The stored chain behind `cause` - route, component, imports, call site - when
   * the head snapshot holds one for the same site. `cause` is the line CI leads
   * with; this is what a reviewer expands.
   *
   * Null when nothing matches. Attaching the nearest chain instead would put a
   * confident-looking import path under a finding it does not explain.
   */
  causeChain: CauseChain | null
}

export interface CacheChange {
  /** Cache reasons present now and absent from the baseline. */
  introduced: string[]
  /** Cache reasons the baseline had and this build does not. */
  resolved: string[]
  /** ISR window movement, when both sides were ISR. */
  revalidate: { before: number; after: number } | null
}

/**
 * A named explanation for a route's change. `component` is what the PR comment
 * prints as "Introduced by", and it is null rather than approximated whenever the
 * evidence names a file but not a component.
 */
export interface Cause {
  kind: 'cache' | 'dynamic-api' | 'mode' | 'module-size' | 'unknown'
  /** Human-readable, e.g. `uncached fetch at lib/http.ts:3`. */
  what: string
  /** `lib/http.ts:3`, when the evidence carries a call site. */
  site: string | null
  /** The component that carries it, when the evidence names one. */
  component: string | null
}

export interface ModuleDelta {
  file: string
  before: number
  after: number
  delta: number
  status: 'added' | 'removed' | 'changed'
}

/**
 * A package whose attributed cost moved, stated once with the routes it reached.
 *
 * This is the unit a reviewer acts on: "someone added `date-fns`" is one
 * decision, where the same fact spread across nine route rows is nine numbers
 * and no decision. Requires source-map attribution - without it `dependencies`
 * is empty on every route and this list is too, which is correct rather than
 * silent, because the coverage figure beside the verdict says why.
 */
export interface DependencyDelta {
  pkg: string
  /**
   * The worst single route, never a sum across routes. A shared chunk is
   * counted in the first load of every route it serves, so adding those
   * together invents bytes that nobody downloads.
   */
  delta: number
  before: number
  after: number
  status: 'added' | 'removed' | 'changed'
  /**
   * The routes this package's change moved, worst first, each with the bytes it
   * moved *there*.
   *
   * Per route rather than a bare pattern list because a consumer that suppresses
   * a route's own detail has to be able to check that this finding accounts for
   * the whole movement: a route that gained 200 kB where this package explains
   * 48 kB still owes the reader the other 152 kB.
   */
  routes: { pattern: string; delta: number }[]
}

/**
 * A `'use client'` boundary whose attributed subtree cost moved, or that started
 * or stopped reaching routes.
 *
 * Same reporting contract as `DependencyDelta`: every number is the worst single
 * route's, never a sum across routes.
 */
export interface BoundaryDelta {
  file: string
  /** Its default-exported component, when either build named one. */
  component: string | null
  delta: number
  before: number
  after: number
  status: 'added' | 'removed' | 'changed'
  routes: { pattern: string; delta: number }[]
}

/** A barrel import whose drag cost moved, with what it started dragging. */
export interface BarrelDelta {
  file: string
  delta: number
  before: number
  after: number
  status: 'added' | 'removed' | 'changed'
  /** Files reaching the worst route *only* through this barrel, before and after. */
  draggedBefore: number
  draggedAfter: number
  /** The ones that are new, for naming a couple of them. */
  newlyDragged: string[]
  routes: { pattern: string; delta: number }[]
}

export interface Diff {
  base: Snapshot
  head: Snapshot
  routes: RouteDelta[]
  /**
   * Package-level movement, grouped across routes. Stated before the route
   * table because one named package answers what a column of byte deltas only
   * describes.
   */
  dependencies: DependencyDelta[]
  /**
   * `'use client'` boundaries whose cost moved. The axis that names a component
   * crossing to the client, which per-file attribution can only describe.
   */
  clientBoundaries: BoundaryDelta[]
  /** Barrel imports whose drag cost moved. Names the import style, not the files. */
  barrels: BarrelDelta[]
  /** True when the two snapshots are not safely comparable. */
  incomparable: string[]
  /**
   * What changed about the build rather than about the code. Reported on its
   * own so a reviewer can tell "someone turned on Cache Components" apart from
   * "someone broke twenty routes" - which look identical in the route table.
   */
  configChanges: ConfigChange[]
}

/**
 * `.perf/aliases.json` - renames the tool cannot infer. Trends are keyed on file
 * path, which survives URL refactors but not file moves; an alias entry
 * (`"app/old/page.tsx": "app/new/page.tsx"`) stitches the history back together.
 */
export type RouteAliases = Record<string, string>

/**
 * Chunk filenames are content-hashed, so a whitespace-only commit moves route
 * totals by a few dozen bytes. Those bytes are real, and reporting them as a
 * regression is how a check trains reviewers to scroll past it. `status` stays
 * exact; only `severity` applies the floor.
 */
export const NOISE_FLOOR_BYTES = 512

export function diffSnapshots(base: Snapshot, head: Snapshot, aliases: RouteAliases = {}): Diff {
  const incomparable: string[] = []

  // Schema first. A record written by an older crust is missing whatever has
  // been added since, and everything below assumes the current shape - the
  // store normalises reads so this cannot crash, but saying so up front is what
  // makes the rest of the function safe to read.
  if (base.schemaVersion !== head.schemaVersion) {
    incomparable.push(
      `snapshot schema changed: v${base.schemaVersion} -> v${head.schemaVersion} - re-run \`crust analyze\` on the baseline commit`,
    )
  }

  // Comparing across bundlers, Next majors or rule sets produces differences
  // that are real but have nothing to do with the change under review, and
  // reporting them as a regression is how a CI check trains people to ignore it.
  const configChanges = compareConfig(base, head)
  incomparable.push(...configChanges.filter((change) => change.incomparable).map((change) => change.summary))

  // Keyed on file path, not URL pattern: patterns change during refactors and the
  // history would silently restart (plan §6). Aliases remap old ids onto new ones
  // so a moved file keeps its trend.
  const beforeById = new Map(base.routes.map((r) => [aliases[r.id] ?? r.id, r]))
  const afterById = new Map(head.routes.map((r) => [r.id, r]))
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])]

  const routes = ids.map((id) => compareRoute(beforeById.get(id), afterById.get(id)))

  // Regressions first, then by how much moved. A reviewer reads the top of the
  // list; the top of the list has to be the reason the check ran.
  const rank = { regression: 0, neutral: 1, improvement: 2 } as const
  routes.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.firstLoadDelta) - Math.abs(a.firstLoadDelta),
  )

  return {
    base,
    head,
    routes,
    dependencies: compareDependencies(beforeById, afterById),
    clientBoundaries: compareBoundaries(beforeById, afterById),
    barrels: compareBarrels(beforeById, afterById),
    incomparable,
    configChanges,
  }
}

/** One route's contribution to a grouped cause. */
interface RouteBytes {
  /**
   * The trend key - the page file path, aliased. Kept beside the pattern because
   * looking a route up again by pattern misses it whenever an alias renamed the
   * URL: the two sides of the comparison then have different patterns for one page.
   */
  id: string
  pattern: string
  delta: number
  before: number
  after: number
}

/**
 * Per-route attributed byte movement, grouped by key.
 *
 * Shared by every attributed axis - packages, client boundaries, barrels - because
 * the grouping question is identical and only the key differs. `bytesOf` says what
 * a route attributes to each key; a key absent from a route contributes zero there,
 * which is what makes "added on this route" and "removed from that one" the same
 * arithmetic.
 *
 * Routes are keyed the way the route table is, so an aliased or renamed page
 * contributes one entry rather than an add and a remove.
 */
function groupMovement(
  beforeById: Map<string, RouteSnapshot>,
  afterById: Map<string, RouteSnapshot>,
  bytesOf: (route: RouteSnapshot) => Map<string, number>,
): Map<string, RouteBytes[]> {
  const byKey = new Map<string, RouteBytes[]>()

  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const before = beforeById.get(id)
    const after = afterById.get(id)
    const was = before ? bytesOf(before) : new Map<string, number>()
    const now = after ? bytesOf(after) : new Map<string, number>()

    for (const key of new Set([...was.keys(), ...now.keys()])) {
      const from = was.get(key) ?? 0
      const to = now.get(key) ?? 0
      if (from === to) continue

      const entry: RouteBytes = {
        id,
        pattern: after?.pattern ?? before?.pattern ?? id,
        delta: to - from,
        before: from,
        after: to,
      }
      const list = byKey.get(key)
      if (list) list.push(entry)
      else byKey.set(key, [entry])
    }
  }

  return byKey
}

/**
 * One key's routes split by direction, growth first.
 *
 * A package or a boundary can shrink on one route and grow on another - a provider
 * moved out of one layout and into another does exactly that. Reported as one row it
 * takes the worst route's direction, so the line says "removed" while the routes it
 * covers include one where it was *added*, and a reader who suppressed that route's
 * detail on the strength of the line was told the opposite of what happened there.
 *
 * Two directions are two facts, so they get two rows: "added, +48 kB on `/b`" and
 * "removed, -84 kB on `/a`" are both true and each explains its own routes.
 */
function splitByDirection(routes: RouteBytes[]): RouteBytes[][] {
  const grew = routes.filter((route) => route.delta > 0)
  const shrank = routes.filter((route) => route.delta < 0)
  return [grew, shrank].filter((group) => group.length > 0)
}

/**
 * The worst single route, and every number reported alongside it taken from *that*
 * route.
 *
 * `before` and `after` used to be per-key maxima collected independently, so a
 * package removed from one route and added to another reported the larger `before`,
 * the larger `after`, and a `status` of `changed` - three numbers describing no
 * build that exists, with `after - before` not equal to the delta beside them.
 * Everything here comes from one route, which is the only way the row is a fact.
 *
 * Expects a single direction (see `splitByDirection`), so `status` describes every
 * route in the row rather than only the worst one.
 *
 * Returns null when the movement is inside the floor the route table already
 * treats as no movement: content-hashed chunks move attributed bytes by a few
 * dozen on a whitespace commit.
 */
function worstOf(routes: RouteBytes[]): {
  worstId: string
  summary: {
    delta: number
    before: number
    after: number
    status: 'added' | 'removed' | 'changed'
    routes: { pattern: string; delta: number }[]
  }
} | null {
  const worst = routes.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
  if (Math.abs(worst.delta) <= NOISE_FLOOR_BYTES) return null

  return {
    worstId: worst.id,
    summary: {
      delta: worst.delta,
      before: worst.before,
      after: worst.after,
      status: worst.before === 0 ? 'added' : worst.after === 0 ? 'removed' : 'changed',
      routes: routes
        .slice()
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .map(({ pattern, delta }) => ({ pattern, delta })),
    },
  }
}

function compareDependencies(
  beforeById: Map<string, RouteSnapshot>,
  afterById: Map<string, RouteSnapshot>,
): DependencyDelta[] {
  const grouped = groupMovement(beforeById, afterById, (route) => new Map(Object.entries(route.dependencies)))

  const deltas: DependencyDelta[] = []
  for (const [pkg, routes] of grouped) {
    for (const group of splitByDirection(routes)) {
      const found = worstOf(group)
      if (found) deltas.push({ pkg, ...found.summary })
    }
  }
  return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

/**
 * Client-boundary movement: a `'use client'` file whose attributed subtree cost
 * changed, or that started or stopped reaching a route at all.
 *
 * This is the axis that names the edit rather than its consequence. "A component
 * crossed from server to client" is one decision with a measured subtree behind
 * it, where the same fact at file granularity is a column of modules that each
 * look like an ordinary import.
 */
function compareBoundaries(
  beforeById: Map<string, RouteSnapshot>,
  afterById: Map<string, RouteSnapshot>,
): BoundaryDelta[] {
  const grouped = groupMovement(
    beforeById,
    afterById,
    (route) => new Map(route.clientBoundaries.map((boundary) => [boundary.file, boundary.bytes])),
  )

  // The component is a property of the file, not of the route, so the first name
  // any side gives it is the name. Null stays null rather than becoming the file.
  const components = new Map<string, string | null>()
  for (const route of [...beforeById.values(), ...afterById.values()]) {
    for (const boundary of route.clientBoundaries) {
      if (!components.get(boundary.file)) components.set(boundary.file, boundary.component)
    }
  }

  const deltas: BoundaryDelta[] = []
  for (const [file, routes] of grouped) {
    for (const group of splitByDirection(routes)) {
      const found = worstOf(group)
      if (found) deltas.push({ file, component: components.get(file) ?? null, ...found.summary })
    }
  }
  return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

/**
 * Barrel movement: an import style whose drag cost changed.
 *
 * `dragged` is what the analyzer proved by re-walking the graph with the barrel
 * removed, so the file count is what deleting the barrel import would actually
 * save - not everything the barrel exports. Reported because it is the difference
 * between "this route got heavier" and "this route pulled in eleven components it
 * never renders".
 */
function compareBarrels(
  beforeById: Map<string, RouteSnapshot>,
  afterById: Map<string, RouteSnapshot>,
): BarrelDelta[] {
  const grouped = groupMovement(
    beforeById,
    afterById,
    (route) => new Map(route.barrels.map((barrel) => [barrel.file, barrel.bytes])),
  )

  // By id, never by pattern. Both sides are keyed on the aliased trend key, so a
  // page whose URL was renamed has two different patterns and one id: looking the
  // baseline up by the head's pattern finds nothing there and reports every file
  // the barrel already dragged as newly dragged.
  const draggedOn = (byId: Map<string, RouteSnapshot>, id: string, file: string): string[] =>
    byId.get(id)?.barrels.find((barrel) => barrel.file === file)?.dragged ?? []

  const deltas: BarrelDelta[] = []
  for (const [file, routes] of grouped) {
    for (const group of splitByDirection(routes)) {
      const found = worstOf(group)
      if (!found) continue

      // From the worst route, for the same reason its bytes are: a count summed
      // across routes counts the same dragged file once per route that loads it.
      const was = new Set(draggedOn(beforeById, found.worstId, file))
      const now = draggedOn(afterById, found.worstId, file)

      deltas.push({
        file,
        draggedBefore: was.size,
        draggedAfter: now.length,
        newlyDragged: now.filter((dragged) => !was.has(dragged)),
        ...found.summary,
      })
    }
  }
  return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

/**
 * Whether bytes are the only thing that got worse on this route.
 *
 * Keyed on what moved, not on which branch of `causeOf` happened to fire: the
 * same byte-only regression is labelled `module-size` when source maps name a
 * file and `unknown` when they do not, and a route that also lost caching or
 * dropped out of the shell has a cause no package line explains.
 */
export function movedOnlyInBytes(route: RouteDelta): boolean {
  return (
    !route.modeChange &&
    !route.cacheChange &&
    route.newHoles.length === 0 &&
    !(route.shellRatioDelta !== null && route.shellRatioDelta < 0) &&
    !(route.shellRatioBefore !== null && route.shellRatioAfter === null)
  )
}

/** Any grouped cause whose byte movement is attributed per route. */
export interface AttributedCause {
  routes: { pattern: string; delta: number }[]
}

export interface ExplainedAxis {
  causes: AttributedCause[]
  /**
   * Whether the axis partitions a route's bytes, so two of its causes on one route
   * can be added together.
   *
   * True for packages: a file in `node_modules` has exactly one owning package, so
   * two package rows are two disjoint sets of bytes.
   *
   * False for client boundaries and barrels. Two boundaries can import the same
   * module, and barrels nest - `components/index.ts` and `components/ui/index.ts`
   * may each count the same dragged files - so their costs overlap by unknown
   * amounts. Adding them would over-explain a route and suppress detail for
   * movement nothing named.
   */
  disjoint: boolean
}

/**
 * Bytes per route that a given set of grouped causes accounts for.
 *
 * Combined by the weakest sound rule available at each level: summed within an axis
 * only when that axis partitions the bytes, and never summed across axes, because a
 * boundary's subtree cost already *contains* the packages it imports. Everywhere
 * else the largest single contribution wins.
 *
 * The consequence is deliberate: overlapping causes under-credit a route, the route
 * looks less explained than it might be, and it keeps its detail. Erring toward
 * printing detail that was arguably redundant is recoverable; erring toward
 * suppressing a regression nothing named is the failure this guards.
 *
 * Only the causes passed in count: callers pass the ones they will print, because
 * a finding the reader never sees explains nothing.
 */
export function explainedBytes(axes: ExplainedAxis[]): Map<string, number> {
  const best = new Map<string, number>()

  for (const axis of axes) {
    const perRoute = new Map<string, number>()
    for (const cause of axis.causes) {
      for (const route of cause.routes) {
        const running = perRoute.get(route.pattern)
        perRoute.set(
          route.pattern,
          running === undefined
            ? route.delta
            : axis.disjoint
              ? running + route.delta
              : Math.max(running, route.delta),
        )
      }
    }
    for (const [pattern, bytes] of perRoute) {
      const current = best.get(pattern)
      if (current === undefined || bytes > current) best.set(pattern, bytes)
    }
  }

  return best
}

/**
 * Whether the package findings a reader can see account for everything this
 * route did - the test for dropping its own detail.
 *
 * Both halves are necessary. The movement has to be bytes only, because no
 * package line explains a rendering-mode drop or a lost cache. And the bytes
 * those findings attribute here have to cover the bytes the route gained: a route
 * that grew 200 kB where the named packages explain 48 kB is mostly unexplained,
 * and dropping its detail would answer the smaller half of the regression while
 * hiding the larger one.
 *
 * Shared by the PR comment and the terminal so one grouped finding replaces route
 * detail identically in both. A grouping that prints above the rows it explains
 * has made the output longer, which is the failure the whole axis exists to fix.
 */
export function fullyExplained(route: RouteDelta, explainedBytes: Map<string, number>): boolean {
  const explained = explainedBytes.get(route.pattern)
  if (explained === undefined || !movedOnlyInBytes(route)) return false
  // The floor the route table already treats as no movement, applied to the
  // remainder: a content-hash shift is not an unexplained regression.
  return route.firstLoadDelta - explained <= NOISE_FLOOR_BYTES
}

function compareRoute(before: RouteSnapshot | undefined, after: RouteSnapshot | undefined): RouteDelta {
  const pattern = after?.pattern ?? before?.pattern ?? '<unknown>'
  const id = after?.id ?? before?.id ?? pattern

  const firstLoadBefore = before?.firstLoadBytes ?? 0
  const firstLoadAfter = after?.firstLoadBytes ?? 0
  const shellBefore = before?.shell?.actual?.shellRatio ?? null
  const shellAfter = after?.shell?.actual?.shellRatio ?? null

  const modeChange = compareModes(
    before?.renderingMode ?? null,
    after?.renderingMode ?? null,
    after?.renderingModeReason ?? null,
  )
  const cacheChange = compareCaching(before, after)
  const holes = newHoles(before, after)
  const modules = compareModules(before?.modules ?? {}, after?.modules ?? {})

  const bytesMoved = firstLoadBefore !== firstLoadAfter
  const shellMoved = shellBefore !== shellAfter

  const status: RouteDelta['status'] = !before
    ? 'added'
    : !after
      ? 'removed'
      : bytesMoved || shellMoved || modeChange || cacheChange || holes.length > 0
        ? 'changed'
        : 'unchanged'

  const delta: RouteDelta = {
    pattern,
    id,
    status,
    severity: 'neutral',
    firstLoadBefore,
    firstLoadAfter,
    firstLoadDelta: firstLoadAfter - firstLoadBefore,
    shellRatioBefore: shellBefore,
    shellRatioAfter: shellAfter,
    shellRatioDelta: shellBefore !== null && shellAfter !== null ? shellAfter - shellBefore : null,
    renderingModeBefore: before?.renderingMode ?? null,
    renderingModeAfter: after?.renderingMode ?? null,
    modeChange,
    cacheChange,
    modules,
    newHoles: holes,
    cause: null,
    causeChain: null,
  }

  delta.severity = severityOf(delta)
  delta.cause = causeOf(delta, after)
  delta.causeChain = chainFor(delta.cause, after)

  // The chain walked the module graph; the one-liner only finds a component when
  // the shell predictor recorded a hole at the same site. Fill in, never overwrite:
  // a component the shell verified is stronger evidence.
  if (delta.cause && !delta.cause.component && delta.causeChain?.component) {
    delta.cause = { ...delta.cause, component: delta.causeChain.component }
  }
  return delta
}

/**
 * A route can get worse in four ways, and only one of them is bytes. Ordering
 * them by which is worst would be arbitrary; any single one is enough to call the
 * route a regression, and `cause` decides which one gets the line of prose.
 */
function severityOf(d: RouteDelta): RouteDelta['severity'] {
  if (d.status === 'unchanged') return 'neutral'
  if (d.status === 'removed') return 'neutral'

  // A route that did not exist in the baseline has a `before` of zero, so its
  // entire size reads as growth and every new page would be announced as a
  // regression. Nothing got worse - there was nothing to get worse than. An
  // absolute budget can still fail it; that is a ceiling, not a regression.
  if (d.status === 'added') return 'neutral'

  const worse =
    d.modeChange?.direction === 'regression' ||
    (d.shellRatioDelta !== null && d.shellRatioDelta < 0) ||
    // A shell that existed and now does not is the most severe version of this,
    // and it reads as `null` rather than as a negative delta.
    (d.shellRatioBefore !== null && d.shellRatioAfter === null) ||
    (d.cacheChange?.introduced.length ?? 0) > 0 ||
    d.newHoles.length > 0 ||
    d.firstLoadDelta > NOISE_FLOOR_BYTES

  if (worse) return 'regression'

  const better =
    d.modeChange?.direction === 'improvement' ||
    (d.shellRatioDelta !== null && d.shellRatioDelta > 0) ||
    (d.cacheChange?.resolved.length ?? 0) > 0 ||
    d.firstLoadDelta < -NOISE_FLOOR_BYTES

  return better ? 'improvement' : 'neutral'
}

/**
 * Blame in priority order of usefulness to whoever has to fix it: a named call
 * site beats a mode label, and a mode label beats a byte count. When a route
 * changed and none of the evidence names anything, that is reported as `unknown`
 * rather than filled in with the largest module - the largest module on almost
 * every route is the framework, which nobody's PR introduced.
 */
function causeOf(d: RouteDelta, after: RouteSnapshot | undefined): Cause | null {
  if (d.status === 'unchanged') return null

  const hole = d.newHoles[0]
  if (hole) {
    const parsed = parseReason(hole.reason)
    return {
      kind: parsed.kind === 'other' ? 'unknown' : parsed.kind,
      what: shortReason(hole.reason),
      site: parsed.site,
      component: hole.component,
    }
  }

  const introduced = d.cacheChange?.introduced[0]
  if (introduced) {
    const parsed = parseReason(introduced)
    return { kind: 'cache', what: shortReason(introduced), site: parsed.site, component: componentFor(after, parsed.site) }
  }

  if (d.modeChange?.direction === 'regression') {
    const reason = d.modeChange.reason ?? after?.dynamicReasons[0] ?? null
    if (reason) {
      const parsed = parseReason(reason)
      return {
        kind: parsed.kind === 'other' ? 'mode' : parsed.kind,
        what: shortReason(reason),
        site: parsed.site,
        component: componentFor(after, parsed.site),
      }
    }
    return {
      kind: 'unknown',
      what: `became ${d.modeChange.after.toLowerCase()} - no dynamic API or uncached fetch found in source`,
      site: null,
      component: null,
    }
  }

  const mod = d.modules[0]
  if (mod && Math.abs(mod.delta) > NOISE_FLOOR_BYTES) {
    return { kind: 'module-size', what: mod.file, site: mod.file, component: null }
  }

  if (Math.abs(d.firstLoadDelta) > NOISE_FLOOR_BYTES) {
    return {
      kind: 'unknown',
      what: 'no module could be blamed for the change - build without source maps?',
      site: null,
      component: null,
    }
  }

  return null
}

/**
 * Matched on the call site - the only key both sides carry verbatim - with the
 * reason text as a fallback for causes that have no position. Anything that does
 * not match is left off; a reviewer follows an import path, so the wrong one sends
 * them somewhere real that is not the problem.
 */
function chainFor(cause: Cause | null, after: RouteSnapshot | undefined): CauseChain | null {
  if (!cause || !after) return null

  const chains = after.causes.filter((chain) => !isBytesChain(chain))
  if (cause.site) {
    const bySite = chains.find((chain) => chain.site === cause.site)
    if (bySite) return bySite
  }
  return chains.find((chain) => cause.what === chain.detail || cause.what.startsWith(`${chain.detail} `)) ?? null
}

/** The shell predictor is the only layer that maps a call site back to a component. */
function componentFor(route: RouteSnapshot | undefined, site: string | null): string | null {
  if (!site || !route?.shell) return null
  const hole = route.shell.predictedHoles.find((h) => parseReason(h.reason).site === site)
  return hole?.component ?? null
}

/**
 * The point of the whole tool: not "this route grew 40 kB" but *which import did it*.
 */
function compareModules(before: Record<string, number>, after: Record<string, number>): ModuleDelta[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)])
  const deltas: ModuleDelta[] = []

  for (const file of files) {
    const a = before[file] ?? 0
    const b = after[file] ?? 0
    if (a === b) continue
    deltas.push({
      file,
      before: a,
      after: b,
      delta: b - a,
      status: a === 0 ? 'added' : b === 0 ? 'removed' : 'changed',
    })
  }

  return deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
}

/**
 * Cache regressions are the ones with no build error and, often, no byte change:
 * a `use cache` directive removed several frames below the page leaves the bundle
 * identical and the shell half its former size. Everything visible about them is
 * in the reason strings, so this diffs those.
 */
function compareCaching(before: RouteSnapshot | undefined, after: RouteSnapshot | undefined): CacheChange | null {
  if (!before || !after) return null

  const beforeKeys = new Map(cacheReasons(before).map((r) => [reasonKey(r), r]))
  const afterKeys = new Map(cacheReasons(after).map((r) => [reasonKey(r), r]))

  const introduced = [...afterKeys].filter(([k]) => !beforeKeys.has(k)).map(([, r]) => r)
  const resolved = [...beforeKeys].filter(([k]) => !afterKeys.has(k)).map(([, r]) => r)

  // A shorter revalidate window is more requests hitting the origin; a longer one
  // is staler HTML. Both are the author's call, so this reports the movement and
  // does not rank it.
  const revalidateBefore = revalidateSeconds(before.renderingModeReason)
  const revalidateAfter = revalidateSeconds(after.renderingModeReason)
  const revalidate =
    revalidateBefore !== null && revalidateAfter !== null && revalidateBefore !== revalidateAfter
      ? { before: revalidateBefore, after: revalidateAfter }
      : null

  if (introduced.length === 0 && resolved.length === 0 && !revalidate) return null
  return { introduced, resolved, revalidate }
}

/**
 * The same call site reaches a route through the taint graph *and* through the
 * shell predictor, in two spellings of the same fact. Keyed on the site they
 * collapse; the shortest spelling wins, because the extra length is always the
 * ` via …` provenance tail and the call site is what needs fixing.
 */
function cacheReasons(route: RouteSnapshot): string[] {
  const all = [...route.dynamicReasons, ...(route.shell?.predictedHoles.map((h) => h.reason) ?? [])]
  const best = new Map<string, string>()
  for (const reason of all) {
    if (parseReason(reason).kind !== 'cache') continue
    const key = reasonKey(reason)
    const current = best.get(key)
    if (current === undefined || reason.length < current.length) best.set(key, reason)
  }
  return [...best.values()]
}

/**
 * A component that used to be in the shell and no longer is. Under Cache Components
 * this is the silent failure the shell engine exists to surface - no build error,
 * no warning, just a smaller shell.
 */
function newHoles(before: RouteSnapshot | undefined, after: RouteSnapshot | undefined): RouteDelta['newHoles'] {
  if (!after?.shell) return []
  const known = new Set((before?.shell?.predictedHoles ?? []).map((h) => h.component))
  return after.shell.predictedHoles
    .filter((h) => !known.has(h.component))
    .map((h) => ({ component: h.component, reason: h.reason }))
}
