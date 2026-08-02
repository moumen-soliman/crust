import type { Diff, RouteDelta } from '../diff/diff.ts'
import type { Snapshot } from '../store/snapshot.ts'
import { kb, pct, signed, type Breach } from './budgets.ts'

/**
 * The PR comment is the growth mechanism (plan §8). Every comment is read by every
 * reviewer, in context, at the moment it matters — a better funnel than any blog
 * post. So it has to earn its place in the thread: lead with the verdict, name the
 * file responsible, and stay quiet when nothing changed.
 */
export function renderComment(snapshot: Snapshot, diff: Diff | null, breaches: Breach[]): string {
  const lines: string[] = []
  const changed = diff?.routes.filter((r) => r.status !== 'unchanged') ?? []

  lines.push('<!-- crust-report -->')
  lines.push(`### ${verdict(breaches, changed)}`)
  lines.push('')

  if (diff?.incomparable.length) {
    lines.push('> [!WARNING]')
    lines.push('> Not comparable to the baseline, so deltas are omitted:')
    for (const reason of diff.incomparable) lines.push(`> - ${reason}`)
    lines.push('')
  }

  if (breaches.length > 0) {
    lines.push('**Budget breaches**')
    lines.push('')
    for (const breach of breaches) {
      lines.push(`- \`${breach.pattern}\` — ${breach.message}`)
      if (breach.blame) lines.push(`  - blame: \`${breach.blame}\``)
    }
    lines.push('')
  }

  if (changed.length > 0) {
    lines.push('| Route | First load | Δ | Shell | Δ |')
    lines.push('|---|--:|--:|--:|--:|')
    for (const route of changed.slice(0, 25)) lines.push(routeRow(route))
    lines.push('')

    const blamed = changed.filter((r) => r.modules.length > 0).slice(0, 5)
    if (blamed.length > 0) {
      lines.push('<details><summary>What changed, by module</summary>')
      lines.push('')
      for (const route of blamed) {
        lines.push(`**\`${route.pattern}\`**`)
        lines.push('')
        for (const mod of route.modules.slice(0, 8)) {
          lines.push(`- \`${mod.file}\` ${signed(mod.delta)} (${mod.status})`)
        }
        lines.push('')
      }
      lines.push('</details>')
      lines.push('')
    }

    const holes = changed.flatMap((r) => r.newHoles.map((h) => ({ pattern: r.pattern, ...h })))
    if (holes.length > 0) {
      lines.push('**Fell out of the static shell**')
      lines.push('')
      for (const hole of holes.slice(0, 10)) {
        lines.push(`- \`${hole.pattern}\` — \`<${hole.component}>\` — ${hole.reason}`)
      }
      lines.push('')
    }
  } else if (diff) {
    lines.push('No route changed size or shell composition.')
    lines.push('')
  }

  lines.push(
    `<sub>${snapshot.routes.length} routes · next ${snapshot.nextVersion} · ${snapshot.bundler} · build \`${snapshot.buildId}\`` +
      `${diff ? ` · vs \`${diff.base.buildId}\`` : ' · no baseline'}</sub>`,
  )

  return lines.join('\n')
}

function routeRow(route: RouteDelta): string {
  const shellAfter = route.shellRatioAfter === null ? '—' : pct(route.shellRatioAfter)
  const shellDelta =
    route.shellRatioDelta === null || route.shellRatioDelta === 0
      ? '—'
      : `${route.shellRatioDelta > 0 ? '+' : ''}${pct(route.shellRatioDelta)}`

  const marker = route.status === 'added' ? ' 🆕' : route.status === 'removed' ? ' 🗑' : ''
  return `| \`${route.pattern}\`${marker} | ${kb(route.firstLoadAfter)} | ${deltaCell(route.firstLoadDelta)} | ${shellAfter} | ${shellDelta} |`
}

function deltaCell(delta: number): string {
  if (delta === 0) return '—'
  return `${delta > 0 ? '⚠️ ' : ''}${signed(delta)}`
}

function verdict(breaches: Breach[], changed: RouteDelta[]): string {
  if (breaches.length > 0) return `crust: ${breaches.length} budget breach${breaches.length === 1 ? '' : 'es'}`
  const shrank = changed.filter((r) => (r.shellRatioDelta ?? 0) < 0)
  if (shrank.length > 0) return `crust: static shell shrank on ${shrank.length} route${shrank.length === 1 ? '' : 's'}`
  if (changed.length > 0) return `crust: ${changed.length} route${changed.length === 1 ? '' : 's'} changed`
  return 'crust: no change'
}
