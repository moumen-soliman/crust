import type { RouteSnapshot, Snapshot } from '../store/snapshot.ts'

export interface RouteDelta {
  pattern: string
  id: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'

  firstLoadBefore: number
  firstLoadAfter: number
  firstLoadDelta: number

  shellRatioBefore: number | null
  shellRatioAfter: number | null
  shellRatioDelta: number | null

  renderingModeBefore: string | null
  renderingModeAfter: string | null

  /** Modules that grew, shrank, appeared or vanished — largest absolute change first. */
  modules: ModuleDelta[]
  /** Holes that appeared since the baseline, with the reason the build gave. */
  newHoles: { component: string; reason: string }[]
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
}

/**
 * `.perf/aliases.json` — renames the tool cannot infer. Trends are keyed on file
 * path, which survives URL refactors but not file moves; an alias entry
 * (`"app/old/page.tsx": "app/new/page.tsx"`) stitches the history back together.
 */
export type RouteAliases = Record<string, string>

export function diffSnapshots(base: Snapshot, head: Snapshot, aliases: RouteAliases = {}): Diff {
  const incomparable: string[] = []

  // Comparing across bundlers or Next majors produces differences that are real
  // but have nothing to do with the change under review, and reporting them as a
  // regression is how a CI check trains people to ignore it.
  if (base.bundler !== head.bundler) {
    incomparable.push(`bundler changed: ${base.bundler} -> ${head.bundler}`)
  }
  if (major(base.nextVersion) !== major(head.nextVersion)) {
    incomparable.push(`Next major changed: ${base.nextVersion} -> ${head.nextVersion}`)
  }
  if (base.schemaVersion !== head.schemaVersion) {
    incomparable.push(`snapshot schema changed: v${base.schemaVersion} -> v${head.schemaVersion}`)
  }

  // Keyed on file path, not URL pattern: patterns change during refactors and the
  // history would silently restart (plan §6). Aliases remap old ids onto new ones
  // so a moved file keeps its trend.
  const beforeById = new Map(base.routes.map((r) => [aliases[r.id] ?? r.id, r]))
  const afterById = new Map(head.routes.map((r) => [r.id, r]))
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])]

  const routes = ids.map((id) => compareRoute(beforeById.get(id), afterById.get(id)))
  routes.sort((a, b) => Math.abs(b.firstLoadDelta) - Math.abs(a.firstLoadDelta))

  return { base, head, routes, incomparable }
}

function compareRoute(before: RouteSnapshot | undefined, after: RouteSnapshot | undefined): RouteDelta {
  const pattern = after?.pattern ?? before?.pattern ?? '<unknown>'
  const id = after?.id ?? before?.id ?? pattern

  const firstLoadBefore = before?.firstLoadBytes ?? 0
  const firstLoadAfter = after?.firstLoadBytes ?? 0
  const shellBefore = before?.shell?.actual?.shellRatio ?? null
  const shellAfter = after?.shell?.actual?.shellRatio ?? null

  const status: RouteDelta['status'] = !before
    ? 'added'
    : !after
      ? 'removed'
      : firstLoadBefore === firstLoadAfter && shellBefore === shellAfter
        ? 'unchanged'
        : 'changed'

  return {
    pattern,
    id,
    status,
    firstLoadBefore,
    firstLoadAfter,
    firstLoadDelta: firstLoadAfter - firstLoadBefore,
    shellRatioBefore: shellBefore,
    shellRatioAfter: shellAfter,
    shellRatioDelta: shellBefore !== null && shellAfter !== null ? shellAfter - shellBefore : null,
    renderingModeBefore: before?.renderingMode ?? null,
    renderingModeAfter: after?.renderingMode ?? null,
    modules: compareModules(before?.modules ?? {}, after?.modules ?? {}),
    newHoles: newHoles(before, after),
  }
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
 * A component that used to be in the shell and no longer is. Under Cache Components
 * this is the silent failure the shell engine exists to surface — no build error,
 * no warning, just a smaller shell.
 */
function newHoles(before: RouteSnapshot | undefined, after: RouteSnapshot | undefined): RouteDelta['newHoles'] {
  if (!after?.shell) return []
  const known = new Set((before?.shell?.predictedHoles ?? []).map((h) => h.component))
  return after.shell.predictedHoles
    .filter((h) => !known.has(h.component))
    .map((h) => ({ component: h.component, reason: h.reason }))
}

const major = (version: string): string => version.split('.')[0] ?? version
