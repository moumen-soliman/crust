import { pct, signed } from '../ci/budgets.ts'
import type { Snapshot } from '../store/snapshot.ts'
import {
  NOISE_FLOOR_BYTES,
  explainedBytes,
  type AttributedCause,
  type BarrelDelta,
  type BoundaryDelta,
  type DependencyDelta,
  type Diff,
  type RouteDelta,
} from './diff.ts'
import { modeLabel } from './mode.ts'
import { parseReason, shortReason } from './reason.ts'

/**
 * What every command leads with, computed once.
 *
 * `diff` and `ci` answer the same question about the same two builds and used to
 * answer it differently: the comment opened with a decision the terminal never
 * stated, the terminal showed coverage the comment never mentioned, and neither
 * said what to do next. Five things belong at the top of all of them - the
 * decision, the changes that drove it, the cause they share, how much of the
 * build backs it up, and the likely next action - so they are derived here and
 * only *rendered* per surface.
 *
 * Nothing here measures anything. It reads what `diffSnapshots` already proved,
 * which is what stops `diff` and `ci` from drifting into two opinions.
 */

/**
 * Structural on purpose: `Breach` from `ci/budgets.ts` satisfies it. Naming that
 * type here would tie the decision to the budget file, and `diff` reaches this
 * same decision with no budgets loaded.
 */
export interface LeadBreach {
  pattern: string
  message: string
}

/**
 * `block` is the only level that should stop a merge, and it is reached by
 * evidence rather than by counting: a route that stopped being static, stopped
 * being cached, lost its shell, or broke a configured ceiling. `review` is real
 * movement with no such finding. `undecidable` is the honest answer when there is
 * no comparable baseline - not `clear`, which would be a claim.
 */
export type DecisionLevel = 'block' | 'review' | 'clear' | 'undecidable'

export interface LeadDecision {
  level: DecisionLevel
  /** One sentence naming the worst single thing. No `crust:` prefix - callers add their own. */
  headline: string
}

export interface LeadChange {
  direction: 'regression' | 'improvement'
  route: string
  /** `no longer static  ·  +48.2 kB` - strongest fact first, bytes appended when they moved too. */
  headline: string
  /** The strongest source location the evidence carries. Null when it carries none. */
  where: string | null
  /**
   * What to do about it. Null for improvements, and never a guess: where the
   * evidence cannot support an action this states what evidence is missing.
   */
  action: string | null
}

/**
 * One cause, stated once, with everything it reached.
 *
 * Both kinds are derived from the diff rather than from a snapshot field. A
 * snapshot's own `sharedCauses` describes one build - a provider reaching nineteen
 * routes in the head probably reached nineteen in the base too - so reporting it
 * as a cause of *the change* would be the persuasive-looking guess this tool is
 * supposed to refuse.
 */
export interface LeadCause {
  /**
   * `package` / `boundary` / `barrel`: attributed bytes moved, and each names a
   * different decision - an import, a `'use client'` line, an import style.
   * `site`: several routes regressed at one call site.
   */
  kind: 'package' | 'boundary' | 'barrel' | 'site'
  label: string
  /**
   * `added`, `removed`, `grew`, `uncached fetch at lib/http.ts:3`. Never carries
   * the route count - `routes.length` is the count, and a renderer that wants it
   * in the sentence composes it where its own punctuation allows.
   */
  what: string
  /** Blast radius, worst first. */
  routes: string[]
  /** What it costs the worst single route, when the cost is measurable. */
  bytesPerRoute: number | null
  /**
   * Per-route attributed movement, for deciding whether this cause explains a
   * route's whole change. Null for causes with no measured bytes, which therefore
   * cannot stand in for a route's byte detail.
   */
  bytesByRoute: { pattern: string; delta: number }[] | null
  component: string | null
  action: string | null
}

export interface LeadCoverage {
  /** `attribution 94%`, or `attribution 90% → 40%` when it moved. */
  text: string
  /** Low enough that an empty cause list means "not measured" rather than "nothing moved". */
  weak: boolean
  /** The evidence that would raise it, when something identifiable is missing. */
  missing: string | null
}

export interface Lead {
  decision: LeadDecision
  /**
   * Regressions first, then improvements. Both are first-class: a comparison that
   * only reports failures cannot say whether a refactor worked.
   */
  changes: LeadChange[]
  causes: LeadCause[]
  /** Null when neither build had client JavaScript to attribute - a percentage with no denominator. */
  coverage: LeadCoverage | null
}

/** Regressions named in the lead before the rest become a count. */
export const LEAD_REGRESSIONS = 3
/** Improvements named in the lead. Fewer than regressions, but never zero when one exists. */
export const LEAD_IMPROVEMENTS = 2
/**
 * Routes at one call site before it is worth stating as a shared cause. Two is a
 * coincidence a reader can hold in their head; three is a pattern, and printing it
 * three times is what the grouping exists to stop.
 */
export const SITE_RADIUS = 3
/** Below this share of client bytes, an empty cause list is a measurement gap. */
const WEAK_ATTRIBUTION = 0.5

export function buildLead(head: Snapshot, diff: Diff | null, breaches: LeadBreach[] = []): Lead {
  const comparable = diff !== null && diff.incomparable.length === 0
  const regressions = comparable ? diff.routes.filter((route) => route.severity === 'regression') : []
  const improvements = comparable ? diff.routes.filter((route) => route.severity === 'improvement') : []
  const causes = comparable ? leadCauses(diff, head) : []

  return {
    decision: decide(diff, breaches, regressions, improvements),
    changes: [
      ...distinct(regressions, causes)
        .slice(0, LEAD_REGRESSIONS)
        .map((route) => change(route, 'regression', causes, head)),
      ...rankImprovements(improvements)
        .slice(0, LEAD_IMPROVEMENTS)
        .map((route) => change(route, 'improvement', causes, head)),
    ],
    causes,
    coverage: comparable ? coverageOf(diff) : null,
  }
}

/**
 * The routes a shared cause already accounts for. Renderers use it to state that
 * cause once instead of once per route it reached.
 */
export function coveredBySite(causes: LeadCause[]): Set<string> {
  const covered = new Set<string>()
  for (const cause of causes) {
    if (cause.kind !== 'site') continue
    for (const route of cause.routes) covered.add(route)
  }
  return covered
}

/**
 * Distinct problems, not distinct routes.
 *
 * Three routes that failed at one call site - or grew by the same provider
 * crossing to the client, or by the same package - are one thing to fix, and
 * naming all three at the top spends a three-line lead restating one cause. The
 * first route of each cause is kept; the rest are the cause's radius, which its
 * own line states.
 *
 * Any cause reaching more than one route collapses, not just call sites: the first
 * real build this ran against printed one boundary's fix three times over, once per
 * route it reached.
 */
function distinct(regressions: RouteDelta[], causes: LeadCause[]): RouteDelta[] {
  const seen = new Set<string>()
  return regressions.filter((route) => {
    const cause = dominantCause(route.pattern, causes)
    // Only a cause that reached more than one route can stand for several of them.
    if (!cause || cause.routes.length < 2) return true
    const key = `${cause.kind}:${cause.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The cause that best explains one route - by what it did *there*, not by how large
 * it was somewhere else.
 *
 * Ranking on the global figure collapsed two unrelated problems into one: a package
 * worth 200 kB on `/heavy` and 1 kB on `/a` claimed `/a` as well, so `/a` - which
 * actually grew from a client boundary - lost its place in the lead to a cause that
 * accounted for 2% of it.
 *
 * A call site wins outright when one covers the route: it explains a route that
 * stopped being static, which no byte figure competes with.
 */
function dominantCause(pattern: string, causes: LeadCause[]): LeadCause | undefined {
  const site = causes.find((cause) => cause.kind === 'site' && cause.routes.includes(pattern))
  if (site) return site

  let best: LeadCause | undefined
  let bestBytes = 0
  for (const cause of causes) {
    const here = cause.bytesByRoute?.find((entry) => entry.pattern === pattern)?.delta ?? 0
    if (here > bestBytes) {
      bestBytes = here
      best = cause
    }
  }
  return best
}

/**
 * The one sentence that has to survive being the only line anyone reads, so it
 * names the single worst thing with its route rather than a count of everything
 * that moved.
 */
function decide(
  diff: Diff | null,
  breaches: LeadBreach[],
  regressions: RouteDelta[],
  improvements: RouteDelta[],
): LeadDecision {
  if (diff === null || diff.incomparable.length > 0) {
    const why = diff === null ? 'no baseline yet' : 'baseline not comparable'
    return breaches.length > 0
      ? { level: 'block', headline: `${breachCount(breaches)} (${why})` }
      : { level: 'undecidable', headline: `${why}, so nothing to compare` }
  }

  const modeDrop = regressions.find((route) => route.modeChange?.direction === 'regression')
  if (modeDrop) {
    return {
      level: 'block',
      headline: `\`${modeDrop.pattern}\` is no longer ${modeLabel(modeDrop.modeChange!.before)}${more(regressions.length)}`,
    }
  }

  const shrank = regressions.filter(lostShell)
  if (shrank.length > 0) {
    return { level: 'block', headline: `static shell shrank on ${count(shrank.length, 'route')}` }
  }

  const uncached = regressions.find((route) => (route.cacheChange?.introduced.length ?? 0) > 0)
  if (uncached) {
    return { level: 'block', headline: `\`${uncached.pattern}\` stopped being cached${more(regressions.length)}` }
  }

  if (breaches.length > 0) return { level: 'block', headline: breachCount(breaches) }
  if (regressions.length > 0) return { level: 'review', headline: `${count(regressions.length, 'route')} grew` }

  // Improvements decide the sentence when nothing regressed. A refactor that took
  // 84 kB off nine routes, reported as "no change", is a comparison tool failing
  // at half its job.
  if (improvements.length > 0) {
    return { level: 'clear', headline: `${count(improvements.length, 'route')} improved, nothing regressed` }
  }

  const configEvidence = diff.configChanges.filter((change) => !change.incomparable)
  if (configEvidence.length > 0) {
    return {
      level: 'clear',
      headline: `${count(configEvidence.length, 'configuration change')}, no route regressed`,
    }
  }

  const changed = diff.routes.filter((route) => route.status !== 'unchanged')
  if (changed.length > 0) {
    return { level: 'clear', headline: `${count(changed.length, 'route')} changed, nothing regressed` }
  }
  return { level: 'clear', headline: 'no change' }
}

/**
 * Improvements ranked by kind before magnitude: a route that became static again
 * matters more than one that shed 2 kB, and sorting on bytes alone buries it.
 */
function rankImprovements(improvements: RouteDelta[]): RouteDelta[] {
  const rank = (route: RouteDelta): number => {
    if (route.modeChange?.direction === 'improvement') return 3
    if ((route.cacheChange?.resolved.length ?? 0) > 0) return 2
    if ((route.shellRatioDelta ?? 0) > 0) return 1
    return 0
  }
  return improvements
    .slice()
    .sort((a, b) => rank(b) - rank(a) || Math.abs(b.firstLoadDelta) - Math.abs(a.firstLoadDelta))
}

function change(
  route: RouteDelta,
  direction: 'regression' | 'improvement',
  causes: LeadCause[],
  head: Snapshot,
): LeadChange {
  return {
    direction,
    route: route.pattern,
    headline: changeHeadline(route, direction),
    where: whereOf(route),
    action: direction === 'regression' ? actionFor(route, causes, head) : null,
  }
}

/** The strongest facts about the movement, bytes appended when they moved too. */
function changeHeadline(route: RouteDelta, direction: 'regression' | 'improvement'): string {
  const parts: string[] = []

  if (route.modeChange) {
    parts.push(
      direction === 'regression'
        ? `no longer ${modeLabel(route.modeChange.before)}`
        : `became ${modeLabel(route.modeChange.after)}`,
    )
  }
  if (route.shellRatioBefore !== null && route.shellRatioAfter === null) {
    parts.push(`static shell ${pct(route.shellRatioBefore)} → none emitted`)
  } else if (route.shellRatioDelta !== null && route.shellRatioDelta !== 0) {
    parts.push(`static shell ${pct(route.shellRatioBefore!)} → ${pct(route.shellRatioAfter!)}`)
  }
  if ((route.cacheChange?.introduced.length ?? 0) > 0) parts.push('stopped being cached')
  if ((route.cacheChange?.resolved.length ?? 0) > 0) parts.push('cached again')
  if (route.cacheChange?.revalidate) {
    parts.push(`revalidate ${route.cacheChange.revalidate.before}s → ${route.cacheChange.revalidate.after}s`)
  }
  if (Math.abs(route.firstLoadDelta) > NOISE_FLOOR_BYTES) parts.push(signed(route.firstLoadDelta))
  if (route.status === 'added') parts.push('new route')
  if (route.status === 'removed') parts.push('route removed')

  return parts.length > 0 ? parts.join('  ·  ') : 'changed'
}

/**
 * The strongest source location the stored evidence supports, in that order: the
 * call site the analyzer parsed, then the chain's own site, then the largest
 * module that moved. Never a component alone - `in <Gallery>` with no file is not
 * somewhere a reader can open.
 */
function whereOf(route: RouteDelta): string | null {
  const component = route.cause?.component ?? route.causeChain?.component ?? null
  const site = route.cause?.site ?? route.causeChain?.site ?? route.modules[0]?.file ?? null
  if (!site) return component ? `in <${component}>` : null
  return component ? `${site} in <${component}>` : site
}

/**
 * The likely next action for one regressed route.
 *
 * Every branch is keyed on evidence this diff carries, and the last one matters
 * most: when nothing can be blamed it says which evidence is missing rather than
 * inventing an action, because an instruction a reviewer cannot act on costs more
 * trust than an admission.
 */
export function actionFor(route: RouteDelta, causes: LeadCause[], head: Snapshot): string | null {
  const parsed = route.cause?.what ? parseReason(route.cause.what) : null

  if (route.modeChange?.direction === 'regression') {
    if (parsed?.kind === 'cache') {
      return 'Cache that read (`use cache`, or `fetch(…, { next: { revalidate } })`) and the route can prerender again.'
    }
    if (parsed?.api) {
      // Partial means a Suspense boundary already saved the rest of the page - telling
      // the author to wrap the read again is the instruction they already followed.
      // Found by comparing two real builds: static `/` → partial via `<Theme>` +
      // `cookies()` inside Suspense, and the lead still said "move it into Suspense".
      if (route.modeChange.after === 'PARTIALLY_STATIC') {
        return `Cache the \`${parsed.api}()\` read (\`use cache\`) if it can be shared across requests, or accept the hole if it must stay per-request.`
      }
      return `Move the \`${parsed.api}()\` read into a component inside \`<Suspense>\` so the rest of the page can prerender.`
    }
    return 'Find what started reading request state on this route; everything above it can prerender once it is isolated.'
  }

  const hole = route.newHoles[0]
  if (hole) {
    return `\`<${hole.component}>\` left the static shell. Cache the read that postponed it, or accept the hole if the data must be per-request.`
  }
  if (lostShell(route)) {
    return 'The shell shrank with no new hole crust could name - open the route in `crust report` for its postponed boundaries.'
  }

  if ((route.cacheChange?.introduced.length ?? 0) > 0) {
    return 'Restore the cache on that read, or set `revalidate` if the data can be stale for a window.'
  }

  // Bytes. A grouped cause that reached this route beats a file, because it is one
  // decision - an import, a `'use client'` line, an import style - and it already
  // carries the sentence for its own kind, so the advice cannot drift between the
  // cause list and the route.
  // Ranked by what each cause did *here*, not by its worst route anywhere: a package
  // that is 1 kB on this route and 200 kB on another would otherwise outrank the
  // boundary that actually accounts for this route's 50 kB.
  const here = (cause: LeadCause): number =>
    cause.bytesByRoute?.find((entry) => entry.pattern === route.pattern)?.delta ?? 0
  const attributed = causes
    .filter((cause) => cause.action !== null && here(cause) > 0)
    .sort((a, b) => here(b) - here(a))[0]
  if (attributed?.action && route.firstLoadDelta > 0) return attributed.action

  const module = route.modules.find((entry) => entry.delta > 0)
  if (module) {
    return `\`${module.file}\` grew ${signed(module.delta)}. If it is only needed after interaction, \`next/dynamic\` takes it out of first load.`
  }

  if (route.firstLoadDelta > NOISE_FLOOR_BYTES) {
    return head.config?.sourceMaps === false
      ? 'No module could be blamed: this build has no browser source maps. Set `productionBrowserSourceMaps: true` and re-run to get the file.'
      : 'No module could be blamed - these bytes map to no first-party file, so they are framework or vendor internals.'
  }
  return null
}

/**
 * Causes worth stating above the route detail, worst first.
 *
 * Packages come from the diffed `dependencies`, so each is something a person did.
 * Sites come from the regressions themselves: three or more routes naming one call
 * site is a single edit with a blast radius, previously printed once per route.
 */
function leadCauses(diff: Diff, head: Snapshot): LeadCause[] {
  const attributed = [
    ...packageCauses(diff.dependencies),
    ...boundaryCauses(diff.clientBoundaries),
    ...barrelCauses(diff.barrels),
  ].sort((a, b) => Math.abs(b.bytesPerRoute ?? 0) - Math.abs(a.bytesPerRoute ?? 0))

  // Call sites first. They explain the regressions that stop a merge - a route
  // that is no longer static - where bytes ask for a review.
  return [...siteCauses(diff.routes, head), ...attributed]
}

/**
 * Bytes the given causes account for, per route.
 *
 * Grouped by axis before summing, because the axes nest: a boundary's subtree cost
 * already contains the packages it imports, so a route credited with both would be
 * over-explained and lose detail for movement nothing named. `explainedBytes` holds
 * that rule; this is the seam callers use, over the causes they actually printed.
 */
export function explainedByCauses(causes: LeadCause[]): Map<string, number> {
  const axes = new Map<LeadCause['kind'], AttributedCause[]>()
  for (const cause of causes) {
    if (!cause.bytesByRoute) continue
    const axis = axes.get(cause.kind) ?? []
    axis.push({ routes: cause.bytesByRoute })
    axes.set(cause.kind, axis)
  }
  return explainedBytes(
    [...axes].map(([kind, causesOfKind]) => ({ causes: causesOfKind, disjoint: DISJOINT[kind] })),
  )
}

/**
 * Whether two causes of this kind on one route can be added together.
 *
 * Packages partition attributed bytes by owning directory. Boundaries can share
 * imports and barrels nest, so their costs overlap by unknown amounts. Call sites
 * carry no bytes and never reach this.
 */
const DISJOINT: Record<LeadCause['kind'], boolean> = {
  package: true,
  boundary: false,
  barrel: false,
  site: false,
}

function packageCauses(deps: DependencyDelta[]): LeadCause[] {
  return deps.map((dep) => ({
    kind: 'package' as const,
    label: dep.pkg,
    // `changed` is a direction, not a verb: 100 kB → 50 kB is a shrink, and calling
    // it "grew" beside a negative delta is the row disagreeing with itself.
    what: dep.status === 'added' ? 'added' : dep.status === 'removed' ? 'removed' : dep.delta > 0 ? 'grew' : 'shrank',
    routes: dep.routes.map((route) => route.pattern),
    bytesPerRoute: dep.delta,
    bytesByRoute: dep.routes,
    component: null,
    action: dep.delta > 0 ? packageAction(dep.pkg) : null,
  }))
}

/**
 * A component crossing to the client is one decision with a measured subtree, and
 * it is the axis per-file attribution cannot state: every dragged file looks like
 * an ordinary import of the page.
 */
function boundaryCauses(boundaries: BoundaryDelta[]): LeadCause[] {
  return boundaries.map((boundary) => {
    // Backticked because these sentences are rendered as Markdown in the PR
    // comment, where a bare `<Provider>` is an HTML tag and disappears.
    const name = boundary.component ? `\`<${boundary.component}>\`` : `\`${boundary.file}\``
    return {
      kind: 'boundary' as const,
      label: boundary.file,
      what:
        boundary.status === 'added'
          ? 'became a client boundary'
          : boundary.status === 'removed'
            ? 'is no longer a client boundary'
            : boundary.delta > 0
              ? 'client subtree grew'
              : 'client subtree shrank',
      routes: boundary.routes.map((route) => route.pattern),
      bytesPerRoute: boundary.delta,
      bytesByRoute: boundary.routes,
      component: boundary.component,
      action:
        boundary.delta <= 0
          ? null
          : boundary.status === 'added'
            ? `${name} pulls its whole subtree into first load. Keep it a server component, or move only the interactive part behind \`'use client'\`.`
            : `${name} is already a client boundary, so everything it newly imports ships with it. Check what it started importing.`,
    }
  })
}

/**
 * A barrel's cost is the import style, not any component: `dragged` is what the
 * analyzer proved by re-walking the graph without it, so the count is what deleting
 * the import would actually save.
 */
function barrelCauses(barrels: BarrelDelta[]): LeadCause[] {
  return barrels.map((barrel) => {
    const gained = barrel.draggedAfter - barrel.draggedBefore
    const examples = barrel.newlyDragged.slice(0, 2).join(', ')
    return {
      kind: 'barrel' as const,
      label: barrel.file,
      what:
        barrel.status === 'added'
          ? 'barrel import added'
          : barrel.status === 'removed'
            ? 'barrel import removed'
            : gained > 0
              ? `barrel drags ${gained} more file${gained === 1 ? '' : 's'}`
              : gained < 0
                ? `barrel drags ${-gained} fewer file${gained === -1 ? '' : 's'}`
                : barrel.delta > 0
                  ? 'barrel cost grew'
                  : 'barrel cost shrank',
      routes: barrel.routes.map((route) => route.pattern),
      bytesPerRoute: barrel.delta,
      bytesByRoute: barrel.routes,
      component: null,
      action:
        barrel.delta <= 0
          ? null
          : `${barrel.draggedAfter} file${barrel.draggedAfter === 1 ? '' : 's'} reach this route only through \`${barrel.file}\`${examples ? ` (new: ${examples})` : ''}. Import them directly and the rest stop shipping.`,
    }
  })
}

/** Regressions sharing one call site, collapsed into the edit they all came from. */
function siteCauses(routes: RouteDelta[], head: Snapshot): LeadCause[] {
  interface Group {
    routes: string[]
    what: string
    component: string | null
    worst: RouteDelta
  }
  const bySite = new Map<string, Group>()

  for (const route of routes) {
    if (route.severity !== 'regression') continue
    const site = route.cause?.site ?? route.causeChain?.site ?? null
    if (!site) continue

    const group = bySite.get(site)
    if (group) {
      group.routes.push(route.pattern)
      group.component ??= route.cause?.component ?? route.causeChain?.component ?? null
    } else {
      bySite.set(site, {
        routes: [route.pattern],
        what: shortReason(route.cause?.what ?? route.causeChain?.detail ?? 'changed'),
        component: route.cause?.component ?? route.causeChain?.component ?? null,
        // The first is the worst: `diffSnapshots` sorts regressions by magnitude,
        // so the action comes from the route with the most at stake.
        worst: route,
      })
    }
  }

  return [...bySite]
    .filter(([, group]) => group.routes.length >= SITE_RADIUS)
    .map(([site, group]) => ({
      kind: 'site' as const,
      label: site,
      what: group.what,
      routes: group.routes,
      bytesPerRoute: null,
      // No measured bytes, so this cause can state why a set of routes regressed
      // but can never stand in for one route's byte detail.
      bytesByRoute: null,
      component: group.component,
      action: actionFor(group.worst, [], head),
    }))
    .sort((a, b) => b.routes.length - a.routes.length)
}

function coverageOf(diff: Diff): LeadCoverage | null {
  const before = attributedShare(diff.base)
  const after = attributedShare(diff.head)
  const known = after ?? before
  if (known === null) return null

  return {
    text:
      before !== null && after !== null && before !== after
        ? `attribution ${pct(before)} → ${pct(after)}`
        : `attribution ${pct(known)}`,
    weak: known < WEAK_ATTRIBUTION,
    missing:
      diff.head.config?.sourceMaps === false
        ? 'browser source maps - `productionBrowserSourceMaps: true` traces bytes to files'
        : null,
  }
}

/**
 * The share of client bytes traced to a file or a package - not the blended
 * `confidence` the analyze view leads with. This is the number the cause list
 * stands on: an empty list reads as "nothing moved" at 94% and as "nothing was
 * measured" at 10%.
 */
function attributedShare(snapshot: Snapshot): number | null {
  const { clientBytesTotal, clientBytesAttributed } = snapshot.coverage
  return clientBytesTotal === 0 ? null : clientBytesAttributed / clientBytesTotal
}

/** `bytesPerRoute` is the worst single route, so the byte figure stays out of this sentence. */
const packageAction = (pkg: string): string =>
  `Check whether \`${pkg}\` needs to be in the client bundle - a server component or a \`next/dynamic\` import removes it from first load.`

const lostShell = (route: RouteDelta): boolean =>
  (route.shellRatioDelta ?? 0) < 0 || (route.shellRatioBefore !== null && route.shellRatioAfter === null)

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
const breachCount = (breaches: LeadBreach[]): string =>
  `${breaches.length} budget breach${breaches.length === 1 ? '' : 'es'}`
const more = (total: number): string => (total > 1 ? `, +${total - 1} more` : '')
