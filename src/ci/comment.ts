import { causeChainLines } from '../analyze/cause.ts'
import type { ConfigChange } from '../analyze/config.ts'
import { NOISE_FLOOR_BYTES, type Diff, type RouteDelta } from '../diff/diff.ts'
import { modeLabel } from '../diff/mode.ts'
import type { CauseChain, Snapshot } from '../store/snapshot.ts'
import { kb, pct, signed, type Breach } from './budgets.ts'

/** What this run could actually be measured against. */
type Basis = 'comparable' | 'incomparable' | 'no-baseline'

/** Regressed routes that get a full block; the rest are counted, not printed. */
const ROUTE_BLOCK_LIMIT = 10
/** Configuration changes listed in the note before it collapses to a count. */
const CONFIG_NOTE_LIMIT = 8

/**
 * The PR comment is the growth mechanism (plan §8). Every comment is read by every
 * reviewer, in context, at the moment it matters - a better funnel than any blog
 * post. So it has to earn its place in the thread.
 *
 * Which means it is ruthless about what it prints. Regressions get prose, with the
 * call site and the component named. Everything else - improvements, routes that
 * moved a few hundred bytes because a chunk hash changed - goes behind a fold or
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

  // Configuration moves for reasons application code did not, so it is reported
  // apart from the route deltas rather than mixed into them: the blocking ones
  // explain why there are no deltas at all, and the rest explain movement the
  // pull request did not cause. A reviewer who cannot tell those apart from a
  // regression has to treat every number as suspect.
  const configChanges = diff?.configChanges ?? []
  const blockingConfig = configChanges.filter((change) => change.incomparable)

  // Segment config appears beside the route it governs, so repeating it here would
  // say the same thing twice. Only for routes that get a block: a declaration on a
  // route behind the fold has nowhere else to appear.
  const printedRoutes = new Set(regressions.slice(0, ROUTE_BLOCK_LIMIT).map((route) => route.pattern))
  const configEvidence = configChanges.filter(
    (change) => !change.incomparable && !(change.route !== undefined && printedRoutes.has(change.route)),
  )

  lines.push('<!-- crust-report -->')
  lines.push(`### ${verdict(breaches, regressions, others, basis, configEvidence)}`)
  lines.push('')

  if (diff?.incomparable.length) {
    // Every entry says what it explains where crust knows. A schema mismatch has
    // no config change behind it, so it stays a bare reason.
    const explanations = new Map(blockingConfig.map((change) => [change.summary, change.explains]))
    lines.push('> [!WARNING]')
    lines.push('> Not comparable to the baseline, so no deltas are reported and no regression')
    lines.push('> check ran:')
    for (const reason of diff.incomparable) {
      const explains = explanations.get(reason)
      lines.push(explains ? `> - ${reason} - explains ${explains}` : `> - ${reason}`)
    }
    lines.push('')
  }

  if (configEvidence.length > 0) {
    const hidden = configEvidence.length - CONFIG_NOTE_LIMIT
    lines.push('> [!NOTE]')
    lines.push('> Build configuration changed. Kept as evidence rather than reported as a')
    lines.push('> regression - what it explains below was not caused by application code:')
    for (const change of configEvidence.slice(0, CONFIG_NOTE_LIMIT)) {
      lines.push(`> - \`${change.key}\`: ${change.before} → ${change.after} - explains ${change.explains}`)
    }
    if (hidden > 0) {
      lines.push(`> - … and ${hidden} more configuration change${hidden === 1 ? '' : 's'}`)
    }
    lines.push('')
  }

  for (const route of regressions.slice(0, ROUTE_BLOCK_LIMIT)) {
    lines.push(...routeBlock(route, configChanges))
    lines.push('')
  }

  if (regressions.length > ROUTE_BLOCK_LIMIT) {
    lines.push(`<sub>… and ${regressions.length - ROUTE_BLOCK_LIMIT} more regressed routes.</sub>`)
    lines.push('')
  }

  if (breaches.length > 0) {
    // The per-route blocks above already named the cause; this is the list of what
    // is actually failing the build, which is a different question.
    lines.push(`**Failing ${breaches.length === 1 ? 'check' : 'checks'}**`)
    lines.push('')
    for (const breach of breaches.slice(0, 15)) {
      lines.push(`- \`${breach.pattern}\` - ${breach.message}`)
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
    `<sub>${snapshot.routes.length} route${snapshot.routes.length === 1 ? '' : 's'} · next ${snapshot.nextVersion} · ${snapshot.bundler} · build \`${snapshot.buildId}\`` +
      `${diff ? ` · vs \`${diff.base.buildId}\`` : ' · no baseline'}</sub>`,
  )

  return lines.join('\n')
}

/**
 * One regressed route, in the shape a reviewer can act on without opening the
 * tool: what moved, what caused it, and who introduced it. Every line is
 * conditional - a route whose shell held but whose mode dropped should not print
 * an unchanged shell percentage, because a number that never moves is a number
 * people stop reading.
 */
function routeBlock(route: RouteDelta, configChanges: ConfigChange[] = []): string[] {
  const lines = [`**\`${route.pattern}\`**${route.status === 'added' ? ' 🆕' : ''}`]
  // A route that dropped to dynamic because someone wrote `export const dynamic` is
  // still a regression, it is just not a mystery. Naming the declaration is the
  // difference between fixing it and hunting for a fetch that does not exist.
  const declared = configChanges.filter((change) => change.route === route.pattern)

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

  for (const change of declared) {
    lines.push(`- Declared: \`${change.setting}\` **${change.before} → ${change.after}**`)
  }

  const cause = route.cause
  // A `Declared:` line above already carries this fact, with before and after.
  const restatesDeclaration = declared.length > 0 && cause?.what.startsWith('route config:') === true
  if (cause) {
    if (!restatesDeclaration) {
      lines.push(cause.kind === 'unknown' ? `- Cause: unknown - ${cause.what}` : `- Cause: \`${cause.what}\``)
    }
    // Which component carries it is evidence the declaration lines do not have.
    if (cause.component) lines.push(`- Introduced by: \`<${cause.component}>\``)
  }

  // Two holes appearing at once usually means one root cause with two call
  // frames, so the extras are worth listing but not worth leading with.
  const extras = route.newHoles.slice(1, 4)
  if (extras.length > 0) {
    lines.push(`- Also left the shell: ${extras.map((h) => `\`<${h.component}>\``).join(', ')}`)
  }

  lines.push(...chainBlock(route.causeChain))

  return lines
}

/**
 * The complete chain, folded away. Inline, a deep import path would push the
 * verdict off the screen; the summary above is what most readers need.
 */
function chainBlock(chain: CauseChain | null): string[] {
  if (!chain || chain.links.length === 0) return []

  const [route, ...rest] = causeChainLines(chain)
  return [
    '',
    '<details><summary>How it reaches this route</summary>',
    '',
    '```text',
    route ?? '',
    ...rest.map((line) => `→ ${line}`),
    '```',
    '',
    // Stated only when it is not the strongest kind. A label on every chain trains
    // the reader to skip it, and then the one that matters is skipped too.
    ...(chain.evidence === 'verified'
      ? []
      : [`<sub>Evidence: ${chain.evidence}${chain.unresolved ? ` - could not follow ${chain.unresolved}` : ''}.</sub>`, '']),
    '</details>',
  ]
}

function routeRow(route: RouteDelta): string {
  const shellAfter = route.shellRatioAfter === null ? '-' : pct(route.shellRatioAfter)
  const shellDelta =
    route.shellRatioDelta === null || route.shellRatioDelta === 0
      ? '-'
      : `${route.shellRatioDelta > 0 ? '+' : ''}${pct(route.shellRatioDelta)}`

  const marker = route.status === 'added' ? ' 🆕' : route.status === 'removed' ? ' 🗑' : ''
  const delta = route.firstLoadDelta === 0 ? '-' : signed(route.firstLoadDelta)
  return `| \`${route.pattern}\`${marker} | ${kb(route.firstLoadAfter)} | ${delta} | ${shellAfter} | ${shellDelta} |`
}

/**
 * The heading is the only part guaranteed to be read - it is what shows in the
 * notification email and the PR timeline. So it names the single worst thing,
 * with the route, rather than a count of everything that moved.
 */
function verdict(
  breaches: Breach[],
  regressions: RouteDelta[],
  others: RouteDelta[],
  basis: Basis,
  configEvidence: ConfigChange[],
): string {
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
  // "No change" would be false on a build whose configuration moved, and it is the
  // heading most likely to be the only line anyone reads.
  if (configEvidence.length > 0) {
    return `crust: ${configEvidence.length} configuration change${configEvidence.length === 1 ? '' : 's'}, no route regressed`
  }
  return 'crust: no change'
}

const suffix = (total: number): string => (total > 1 ? `, +${total - 1} more` : '')
