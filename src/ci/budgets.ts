import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Budgets, Snapshot } from '../store/snapshot.ts'
import type { Diff } from '../diff/diff.ts'

export interface Breach {
  pattern: string
  kind: 'first-load' | 'growth' | 'shell-ratio'
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
 * Budgets cover both axes the tool measures: bundle size and shell ratio. A check
 * that only guards bytes would pass a PR that silently halved the static shell,
 * which is the regression nothing else on the market catches.
 */
export function checkBudgets(snapshot: Snapshot, budgets: Budgets, diff: Diff | null): Breach[] {
  const breaches: Breach[] = []

  for (const route of snapshot.routes) {
    const limit = budgets.firstLoadBytes?.[route.pattern] ?? budgets.defaultFirstLoadBytes
    if (limit !== undefined && route.firstLoadBytes > limit) {
      breaches.push({
        pattern: route.pattern,
        kind: 'first-load',
        message: `first-load JS ${kb(route.firstLoadBytes)} exceeds budget ${kb(limit)}`,
        blame: heaviestContributor(route),
      })
    }

    const minRatio = budgets.minShellRatio?.[route.pattern] ?? budgets.defaultMinShellRatio
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

  if (budgets.maxGrowth !== undefined && diff) {
    for (const delta of diff.routes) {
      if (delta.firstLoadBefore === 0 || delta.firstLoadDelta <= 0) continue
      const growth = delta.firstLoadDelta / delta.firstLoadBefore
      if (growth > budgets.maxGrowth) {
        breaches.push({
          pattern: delta.pattern,
          kind: 'growth',
          message: `first-load JS grew ${pct(growth)} (+${kb(delta.firstLoadDelta)}), over the ${pct(budgets.maxGrowth)} limit`,
          blame: delta.modules[0] ? `${delta.modules[0].file} ${signed(delta.modules[0].delta)}` : null,
        })
      }
    }
  }

  return breaches
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
