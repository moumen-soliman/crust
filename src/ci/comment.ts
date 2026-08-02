import { NOISE_FLOOR_BYTES, type Diff, type RouteDelta } from '../diff/diff.ts'
import { modeLabel } from '../diff/mode.ts'
import type { Snapshot } from '../store/snapshot.ts'
import { kb, pct, signed, type Breach } from './budgets.ts'

/** What this run could actually be measured against. */
type Basis = 'comparable' | 'incomparable' | 'no-baseline'

/**
 * The PR comment is the growth mechanism (plan §8). Every comment is read by every
 * reviewer, in context, at the moment it matters — a better funnel than any blog
 * post. So it has to earn its place in the thread.
 *
 * Which means it is ruthless about what it prints. Regressions get prose, with the
 * call site and the component named. Everything else — improvements, routes that
 * moved a few hundred bytes because a chunk hash changed — goes behind a fold or
 * does not appear at all. A comment that lists every route on every PR is a
 * comment reviewers learn to collapse, and a collapsed comment catches nothing.
 */
export function renderComment(snapshot: Snapshot, diff: Diff | null, breaches: Breach[]): string {
  const lines: string[] = []
  // "Deltas are omitted" has to mean omitted. Printing a regression block under
  // that warning is worse than printing nothing: it states a cause and a
  // component for a difference the tool has just said it cannot attribute.
  // Three distinct states, and collapsing any two of them misreports the run:
  // no baseline at all (a first run, nothing is wrong), a baseline that cannot be
  // compared (a bundler or Next-major change), and a real comparison.
  const basis: Basis = diff === null ? 'no-baseline' : diff.incomparable.length > 0 ? 'incomparable' : 'comparable'
  const comparable = basis === 'comparable' && diff !== null
  const regressions = comparable ? diff.routes.filter((r) => r.severity === 'regression') : []
  const others = comparable
    ? diff.routes.filter((r) => r.status !== 'unchanged' && r.severity !== 'regression')
    : []

  lines.push('<!-- crust-report -->')
  lines.push(`### ${verdict(breaches, regressions, others, basis)}`)
  lines.push('')

  if (diff?.incomparable.length) {
    lines.push('> [!WARNING]')
    lines.push('> Not comparable to the baseline, so no deltas are reported and no regression')
    lines.push('> check ran:')
    for (const reason of diff.incomparable) lines.push(`> - ${reason}`)
    lines.push('')
  }

  for (const route of regressions.slice(0, 10)) {
    lines.push(...routeBlock(route))
    lines.push('')
  }

  if (regressions.length > 10) {
    lines.push(`<sub>… and ${regressions.length - 10} more regressed routes.</sub>`)
    lines.push('')
  }

  if (breaches.length > 0) {
    // The per-route blocks above already named the cause; this is the list of what
    // is actually failing the build, which is a different question.
    lines.push(`**Failing ${breaches.length === 1 ? 'check' : 'checks'}**`)
    lines.push('')
    for (const breach of breaches.slice(0, 15)) {
      lines.push(`- \`${breach.pattern}\` — ${breach.message}`)
    }
    lines.push('')
  }

  if (others.length > 0) {
    lines.push(`<details><summary>${others.length} other route${others.length === 1 ? '' : 's'} changed</summary>`)
    lines.push('')
    lines.push('| Route | First load | Δ | Shell | Δ |')
    lines.push('|---|--:|--:|--:|--:|')
    for (const route of others.slice(0, 40)) lines.push(routeRow(route))
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  if (comparable && regressions.length === 0 && others.length === 0) {
    lines.push('No route changed size, shell composition, rendering mode or caching.')
    lines.push('')
  }

  lines.push(
    `<sub>${snapshot.routes.length} routes · next ${snapshot.nextVersion} · ${snapshot.bundler} · build \`${snapshot.buildId}\`` +
      `${diff ? ` · vs \`${diff.base.buildId}\`` : ' · no baseline'}</sub>`,
  )

  return lines.join('\n')
}

/**
 * One regressed route, in the shape a reviewer can act on without opening the
 * tool: what moved, what caused it, and who introduced it. Every line is
 * conditional — a route whose shell held but whose mode dropped should not print
 * an unchanged shell percentage, because a number that never moves is a number
 * people stop reading.
 */
function routeBlock(route: RouteDelta): string[] {
  const lines = [`**\`${route.pattern}\`**${route.status === 'added' ? ' 🆕' : ''}`]

  if (route.modeChange) {
    lines.push(`- rendering: **${modeLabel(route.modeChange.before)} → ${modeLabel(route.modeChange.after)}**`)
  }

  if (route.shellRatioBefore !== null && route.shellRatioAfter === null) {
    lines.push(`- static shell: **${pct(route.shellRatioBefore)} → none emitted**`)
  } else if (route.shellRatioDelta !== null && route.shellRatioDelta !== 0) {
    lines.push(`- static shell: **${pct(route.shellRatioBefore!)} → ${pct(route.shellRatioAfter!)}**`)
  }

  const cache = route.cacheChange
  if (cache?.revalidate) {
    lines.push(`- revalidate: **${cache.revalidate.before}s → ${cache.revalidate.after}s**`)
  }

  if (Math.abs(route.firstLoadDelta) > NOISE_FLOOR_BYTES) {
    lines.push(`- first load: **${kb(route.firstLoadAfter)}** (${signed(route.firstLoadDelta)})`)
  }

  const cause = route.cause
  if (cause) {
    lines.push(cause.kind === 'unknown' ? `- Cause: unknown — ${cause.what}` : `- Cause: \`${cause.what}\``)
    if (cause.component) lines.push(`- Introduced by: \`<${cause.component}>\``)
  }

  // Two holes appearing at once usually means one root cause with two call
  // frames, so the extras are worth listing but not worth leading with.
  const extras = route.newHoles.slice(1, 4)
  if (extras.length > 0) {
    lines.push(`- Also left the shell: ${extras.map((h) => `\`<${h.component}>\``).join(', ')}`)
  }

  return lines
}

function routeRow(route: RouteDelta): string {
  const shellAfter = route.shellRatioAfter === null ? '—' : pct(route.shellRatioAfter)
  const shellDelta =
    route.shellRatioDelta === null || route.shellRatioDelta === 0
      ? '—'
      : `${route.shellRatioDelta > 0 ? '+' : ''}${pct(route.shellRatioDelta)}`

  const marker = route.status === 'added' ? ' 🆕' : route.status === 'removed' ? ' 🗑' : ''
  const delta = route.firstLoadDelta === 0 ? '—' : signed(route.firstLoadDelta)
  return `| \`${route.pattern}\`${marker} | ${kb(route.firstLoadAfter)} | ${delta} | ${shellAfter} | ${shellDelta} |`
}

/**
 * The heading is the only part guaranteed to be read — it is what shows in the
 * notification email and the PR timeline. So it names the single worst thing,
 * with the route, rather than a count of everything that moved.
 */
function verdict(breaches: Breach[], regressions: RouteDelta[], others: RouteDelta[], basis: Basis): string {
  if (basis !== 'comparable') {
    const why = basis === 'no-baseline' ? 'no baseline yet' : 'baseline not comparable'
    return breaches.length > 0
      ? `crust: ${breaches.length} budget breach${breaches.length === 1 ? '' : 'es'} (${why})`
      : `crust: ${why}, so nothing to compare`
  }

  const modeDrop = regressions.find((r) => r.modeChange?.direction === 'regression')
  if (modeDrop) {
    return `crust: \`${modeDrop.pattern}\` is no longer ${modeLabel(modeDrop.modeChange!.before)}${suffix(regressions.length)}`
  }

  const shrank = regressions.filter((r) => (r.shellRatioDelta ?? 0) < 0 || (r.shellRatioBefore !== null && r.shellRatioAfter === null))
  if (shrank.length > 0) {
    return `crust: static shell shrank on ${shrank.length} route${shrank.length === 1 ? '' : 's'}`
  }

  const uncached = regressions.find((r) => (r.cacheChange?.introduced.length ?? 0) > 0)
  if (uncached) return `crust: \`${uncached.pattern}\` stopped being cached${suffix(regressions.length)}`

  if (breaches.length > 0) return `crust: ${breaches.length} budget breach${breaches.length === 1 ? '' : 'es'}`
  if (regressions.length > 0) return `crust: ${regressions.length} route${regressions.length === 1 ? '' : 's'} grew`
  if (others.length > 0) return `crust: ${others.length} route${others.length === 1 ? '' : 's'} changed, nothing regressed`
  return 'crust: no change'
}

const suffix = (total: number): string => (total > 1 ? `, +${total - 1} more` : '')
