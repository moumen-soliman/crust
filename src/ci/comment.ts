import { causeChainLines } from '../analyze/cause.ts'
import type { ConfigChange } from '../analyze/config.ts'
import { NOISE_FLOOR_BYTES, fullyExplained, type Diff, type RouteDelta } from '../diff/diff.ts'
import {
  actionFor,
  buildLead,
  coveredBySite,
  explainedByCauses,
  type LeadCause,
} from '../diff/lead.ts'
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
 * Grouped causes listed before the rest collapse to a count. One cap for every
 * axis together, so comparing another one cannot make this comment longer.
 */
const CAUSE_LIMIT = 6
/** Affected routes named on a cause line before it says "+N more". */
const DEPENDENCY_ROUTE_LIMIT = 2
/**
 * Route blocks kept per shared cause. The cause line above states the call site,
 * the component and the radius; the blocks add each route's before and after,
 * which is worth having twice and not nine times.
 */
const BLOCKS_PER_SITE = 2

/**
 * Drops the route blocks a shared-cause line has already accounted for, past the
 * first couple.
 *
 * The cap is what makes the cause line cheaper than the rows it replaces. Without
 * it the section is an addition, and a comment that grew is the failure this whole
 * axis exists to fix. Order is preserved, so the routes that keep blocks are the
 * worst ones - `diffSnapshots` sorted them by magnitude.
 */
function capBySite(regressions: RouteDelta[], siteCauses: LeadCause[]): RouteDelta[] {
  if (siteCauses.length === 0) return regressions

  const siteOf = new Map<string, string>()
  for (const cause of siteCauses) {
    for (const route of cause.routes) siteOf.set(route, cause.label)
  }

  const kept = new Map<string, number>()
  return regressions.filter((route) => {
    const site = siteOf.get(route.pattern)
    if (site === undefined) return true
    const seen = kept.get(site) ?? 0
    kept.set(site, seen + 1)
    return seen < BLOCKS_PER_SITE
  })
}

/**
 * One cause, one line, plus its action.
 *
 * `date-fns` added · +48.2 kB on `/checkout`, `/cart`, +7 more
 * `<Provider>` became a client boundary · +84.0 kB on `/`, +18 more
 * `uncached fetch at lib/http.ts:3` · 9 routes: `/a`, `/b`, +7 more
 *
 * The worst route is named because that is where the cost is worth arguing about;
 * the count behind it is the blast radius, which is what makes one line worth more
 * than the rows it replaces.
 */
function causeLines(cause: LeadCause): string[] {
  const named = cause.routes.slice(0, DEPENDENCY_ROUTE_LIMIT).map((route) => `\`${route}\``).join(', ')
  const rest = cause.routes.length - DEPENDENCY_ROUTE_LIMIT
  const where = rest > 0 ? `${named}, +${rest} more` : named

  // A named component beats its file: `<Provider>` is what a reviewer recognises,
  // and the file is one click away in the chain. A call site's `what` already
  // contains the site, so it is the subject rather than a suffix repeating it.
  const subject =
    cause.kind === 'site'
      ? cause.what
      : cause.kind === 'boundary' && cause.component
        ? `<${cause.component}>`
        : cause.label
  const verb = cause.kind === 'site' ? '' : ` ${cause.what}`
  const radius =
    cause.bytesPerRoute === null
      ? `${cause.routes.length} route${cause.routes.length === 1 ? '' : 's'}: ${where}`
      : `${signed(cause.bytesPerRoute)} on ${where}`

  const lines = [`- \`${subject}\`${verb} · ${radius}`]
  // The action belongs here rather than on each route's block: one cause, one fix,
  // and the blocks below are about what each route lost.
  if (cause.action) lines.push(`  - ${cause.action}`)
  return lines
}

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

  // The same decision, changes, causes and coverage `crust diff` leads with, so
  // the two commands cannot reach different conclusions about the same pair.
  const lead = buildLead(snapshot, diff, breaches)

  // One capped list for every axis - packages, client boundaries, barrels, call
  // sites - so comparing another axis can never add a section.
  //
  // A route whose only movement is a named cause's bytes would otherwise restate
  // that line, once per route, which is the shape the section exists to remove. It
  // still counts as a regression in the verdict and still fails its budget; it just
  // does not get a block repeating a cause already named. Anything with a stronger
  // cause - a mode drop, a cache change, a new shell hole - keeps its block,
  // because bytes do not explain those.
  //
  // Only printed lines can do that work, so the set is `shownCauses` rather than
  // every cause found: one collapsed into "and N more" explains nothing, and
  // suppressing a route on its behalf leaves a regression counted in the verdict
  // with no stated cause anywhere in the comment.
  const shownCauses = lead.causes.slice(0, CAUSE_LIMIT)
  const siteCauses = shownCauses.filter((cause) => cause.kind === 'site')
  const statedBySite = coveredBySite(siteCauses)
  const explained = explainedByCauses(shownCauses)

  const regressionBlocks = capBySite(
    regressions.filter((route) => !fullyExplained(route, explained)),
    siteCauses,
  )

  // Segment config appears beside the route it governs, so repeating it here would
  // say the same thing twice. Only for routes that get a block: a declaration on a
  // route behind the fold has nowhere else to appear.
  const printedRoutes = new Set(regressionBlocks.slice(0, ROUTE_BLOCK_LIMIT).map((route) => route.pattern))
  const configEvidence = configChanges.filter(
    (change) => !change.incomparable && !(change.route !== undefined && printedRoutes.has(change.route)),
  )

  lines.push('<!-- crust-report -->')
  lines.push(`### crust: ${lead.decision.headline}`)
  lines.push('')

  // Coverage beside the verdict, because it bounds what the verdict is worth: the
  // same deltas measured at 40% attribution are correct about bytes and much
  // weaker about causes, and nothing else in the comment tells those apart.
  if (lead.coverage) {
    const missing = lead.coverage.weak && lead.coverage.missing ? ` - missing ${lead.coverage.missing}` : ''
    lines.push(`<sub>${lead.coverage.text}${missing}</sub>`)
    lines.push('')
  }

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

  // Improvements, led rather than folded away. A build-comparison tool that only
  // reports failures cannot tell anyone whether a refactor worked, and a removed
  // package or a route that became static again is the evidence that it did.
  // Regressions are not repeated here - the heading names the worst one and each
  // gets a block below, so a matching list of one-liners would only be the same
  // routes twice.
  const improved = lead.changes.filter((change) => change.direction === 'improvement')
  if (improved.length > 0) {
    lines.push('**Improved**')
    lines.push('')
    for (const change of improved) lines.push(`- \`${change.route}\` - ${change.headline}`)
    const rest = others.filter((route) => route.severity === 'improvement').length - improved.length
    if (rest > 0) lines.push(`- … and ${rest} more improved route${rest === 1 ? '' : 's'}`)
    lines.push('')
  }

  // One cause, one line, with everything it reached. Stated before the route
  // blocks because a named cause *is* the decision - "someone added `date-fns`",
  // "<Provider> crossed to the client" - where the same fact spread down a byte
  // column is nine numbers and no decision. They pay for their lines by removing
  // route detail: see `fullyExplained` and `capBySite`.
  if (shownCauses.length > 0) {
    lines.push(`**Cause${shownCauses.length === 1 ? '' : 's'}**`)
    lines.push('')
    for (const cause of shownCauses) lines.push(...causeLines(cause))
    const hidden = lead.causes.length - shownCauses.length
    if (hidden > 0) lines.push(`- … and ${hidden} more cause${hidden === 1 ? '' : 's'}`)
    lines.push('')
  }

  for (const route of regressionBlocks.slice(0, ROUTE_BLOCK_LIMIT)) {
    lines.push(
      ...routeBlock(route, configChanges, {
        causes: lead.causes,
        head: snapshot,
        // A shared cause line above already gave the fix for every route it
        // reached, so repeating it per block would print one action three times.
        withAction: !statedBySite.has(route.pattern),
      }),
    )
    lines.push('')
  }

  // Covers both truncation and the routes the cause lines already explained, so the
  // count is of regressions without a block rather than of a slice. "More" only
  // when something came before it: with every block suppressed, "and 3 more" reads
  // as three on top of three.
  const printed = Math.min(regressionBlocks.length, ROUTE_BLOCK_LIMIT)
  const withoutBlock = regressions.length - printed
  if (withoutBlock > 0) {
    const routes = `regressed route${withoutBlock === 1 ? '' : 's'}`
    lines.push(
      printed > 0
        ? `<sub>… and ${withoutBlock} more ${routes}.</sub>`
        : `<sub>${withoutBlock} ${routes}, each explained by the causes above.</sub>`,
    )
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
/**
 * `context` carries what the action sentence needs: the causes it can point at and
 * the head snapshot, whose `sourceMaps` flag decides whether an unblamable byte
 * change is a missing map or genuinely vendor internals.
 */
function routeBlock(
  route: RouteDelta,
  configChanges: ConfigChange[] = [],
  context?: { causes: LeadCause[]; head: Snapshot; withAction: boolean },
): string[] {
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

  // The block states what changed and where; without this it never says what to
  // do about it, which leaves the reader to derive the fix from a call site. Comes
  // from the same `actionFor` the terminal uses, so the two never disagree.
  const action = context?.withAction ? actionFor(route, context.causes, context.head) : null
  if (action) lines.push(`- **Do this:** ${action}`)

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

// The heading, the changes it names, the causes and the coverage all come from
// `diff/lead.ts` now. It used to be computed here, which is how `crust diff` ended
// up with no decision at all: the sentence a reviewer reads first existed only in
// the PR comment.
