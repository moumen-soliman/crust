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

export interface Diff {
  base: Snapshot
  head: Snapshot
  routes: RouteDelta[]
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

  return { base, head, routes, incomparable, configChanges }
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
