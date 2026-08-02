import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Budgets, Snapshot } from '../store/snapshot.ts'
import type { Diff, RouteDelta } from '../diff/diff.ts'
import { modeLabel } from '../diff/mode.ts'
import { shortReason } from '../diff/reason.ts'

export interface Breach {
  pattern: string
  kind: 'first-load' | 'growth' | 'shell-ratio' | 'rendering-mode' | 'cache'
  message: string
  /** The module or call site responsible, when we can name one. */
  blame: string | null
}

export async function readBudgets(root: string): Promise<Budgets | null> {
  try {
    return JSON.parse(await readFile(join(root, '.perf', 'budgets.json'), 'utf8')) as Budgets
  } catch {
    return null
  }
}

/**
 * Two kinds of rule live here, and the difference matters.
 *
 * *Thresholds* — how many bytes is too many, how small a shell is too small —
 * cannot be guessed for someone else's app, so they do nothing until a budget
 * file names a number.
 *
 * *Regressions* — a route that was static and is now dynamic, a fetch that was
 * cached and is not — need no threshold. They are a strict downgrade against this
 * project's own previous build, so they are enforced the moment a baseline
 * exists, with no configuration at all. That is the whole claim of the tool: a
 * check that only guards bytes passes a PR that silently halved the static shell.
 */
export function checkBudgets(snapshot: Snapshot, budgets: Budgets | null, diff: Diff | null): Breach[] {
  const breaches: Breach[] = []
  const exempt = new Set(budgets?.allowRegression ?? [])

  for (const route of snapshot.routes) {
    const limit = budgets?.firstLoadBytes?.[route.pattern] ?? budgets?.defaultFirstLoadBytes
    if (limit !== undefined && route.firstLoadBytes > limit) {
      breaches.push({
        pattern: route.pattern,
        kind: 'first-load',
        message: `first-load JS ${kb(route.firstLoadBytes)} exceeds budget ${kb(limit)}`,
        blame: heaviestContributor(route),
      })
    }

    const minRatio = budgets?.minShellRatio?.[route.pattern] ?? budgets?.defaultMinShellRatio
    const ratio = route.shell?.actual?.shellRatio
    if (minRatio !== undefined && ratio !== undefined && ratio !== null && ratio < minRatio) {
      breaches.push({
        pattern: route.pattern,
        kind: 'shell-ratio',
        message: `static shell is ${pct(ratio)} of the route, below the ${pct(minRatio)} floor`,
        blame: route.shell?.predictedHoles[0]?.reason ?? null,
      })
    }
  }

  // Every rule below reads a delta, and a delta is only meaningful between two
  // comparable builds. Across a bundler swap or a Next major the numbers move for
  // reasons that have nothing to do with the change under review, so enforcing
  // them would fail the one PR that is least able to do anything about it. The
  // ceilings above still apply — they describe this build alone.
  if (!diff || diff.incomparable.length > 0) return breaches

  for (const delta of diff.routes) {
    // `allowRegression` exempts the zero-config rules, which are the ones this
    // tool turned on by itself. A growth budget is a number the project chose to
    // write down; silently switching it off for the same route would be crust
    // overriding an explicit decision with an implicit one.
    if (!exempt.has(delta.pattern)) breaches.push(...regressionsFor(delta))
    breaches.push(...growthFor(delta, budgets))
  }

  return breaches
}

function growthFor(delta: RouteDelta, budgets: Budgets | null): Breach[] {
  if (budgets?.maxGrowth === undefined || delta.firstLoadBefore <= 0 || delta.firstLoadDelta <= 0) return []

  const growth = delta.firstLoadDelta / delta.firstLoadBefore
  if (growth <= budgets.maxGrowth) return []

  return [
    {
      pattern: delta.pattern,
      kind: 'growth',
      message: `first-load JS grew ${pct(growth)} (+${kb(delta.firstLoadDelta)}), over the ${pct(budgets.maxGrowth)} limit`,
      blame: delta.modules[0] ? `${delta.modules[0].file} ${signed(delta.modules[0].delta)}` : causeText(delta),
    },
  ]
}

function regressionsFor(delta: RouteDelta): Breach[] {
  const breaches: Breach[] = []
  const blame = delta.cause ? causeText(delta) : null

  // Only `regression` fails. `unknown` means one side of the comparison is a mode
  // with no place on the staticness scale, and failing a build on a direction we
  // could not determine is exactly the false positive that gets a check disabled.
  if (delta.modeChange?.direction === 'regression') {
    breaches.push({
      pattern: delta.pattern,
      kind: 'rendering-mode',
      message: `rendering mode dropped ${modeLabel(delta.modeChange.before)} -> ${modeLabel(delta.modeChange.after)}`,
      blame,
    })
  }

  const introduced = delta.cacheChange?.introduced ?? []
  if (introduced.length > 0) {
    breaches.push({
      pattern: delta.pattern,
      kind: 'cache',
      message:
        introduced.length === 1
          ? `stopped being cached: ${shortReason(introduced[0]!)}`
          : `${introduced.length} reads stopped being cached, starting with ${shortReason(introduced[0]!)}`,
      blame,
    })
  }

  // A route that had a measurable shell and now emits none is a shell ratio of
  // zero, but it reads as `null` — the check that guards the ratio never sees it.
  if (delta.shellRatioBefore !== null && delta.shellRatioAfter === null && delta.modeChange === null) {
    breaches.push({
      pattern: delta.pattern,
      kind: 'shell-ratio',
      message: `no static shell is emitted any more (was ${pct(delta.shellRatioBefore)})`,
      blame,
    })
  }

  return breaches
}

function causeText(delta: RouteDelta): string | null {
  const cause = delta.cause
  if (!cause) return null
  if (cause.kind === 'unknown') return `unknown — ${cause.what}`
  return cause.component ? `${cause.what} (in <${cause.component}>)` : cause.what
}

/**
 * Blame the biggest thing in the bundle, whichever kind of thing it is. Naming a
 * 0.2 kB source file as the cause of a 543 kB budget breach is technically the
 * largest *module*, and useless — on most real routes the framework and a couple
 * of dependencies dominate, and that is the actionable answer.
 */
function heaviestContributor(route: { modules: Record<string, number>; dependencies: Record<string, number>; unattributedBytes: number }): string | null {
  const candidates: [string, number][] = [
    ...Object.entries(route.modules),
    ...Object.entries(route.dependencies).map(([pkg, bytes]): [string, number] => [`${pkg} (dependency)`, bytes]),
  ]
  if (candidates.length === 0) {
    return route.unattributedBytes > 0 ? `${kb(route.unattributedBytes)} unattributed — no source map` : null
  }
  const [name, bytes] = candidates.reduce((a, b) => (b[1] > a[1] ? b : a))
  return `${name} (${kb(bytes)})`
}

export const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`
export const pct = (ratio: number): string => `${(ratio * 100).toFixed(0)}%`
export const signed = (bytes: number): string => `${bytes >= 0 ? '+' : ''}${kb(bytes)}`
