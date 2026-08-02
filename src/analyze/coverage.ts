import type { Coverage, RouteSnapshot } from '../store/snapshot.ts'

/**
 * How much of a build the analysis could actually account for.
 *
 * The roadmap's rule is that confidence must come from measurable coverage
 * rather than a feeling, so every input here is a count this run produced and
 * every count is kept in the output. A reader who thinks attribution should
 * matter more than classification can recompute the number from the parts; a
 * bare score with no visible denominator is exactly what this is not.
 */
export function computeCoverage(routes: RouteSnapshot[]): Coverage {
  // Route handlers have no client bundle, no shell and no rendering mode. They
  // are not gaps in the analysis, so counting them as unclassified would make
  // an API-heavy app look unanalysable when nothing was missed.
  const measurable = routes.filter((route) => route.renderingMode !== 'ROUTE_HANDLER')

  const routesTotal = measurable.length
  const routesClassified = measurable.filter((route) => route.renderingMode !== 'unknown').length

  const shellsEmitted = measurable.filter((route) => route.shell?.actual).length
  const shellsMeasured = measurable.filter((route) => route.shell?.actual && route.shell.agreement !== null).length

  let clientBytesTotal = 0
  let clientBytesAttributed = 0
  for (const route of measurable) {
    // Bytes traced to a dependency are attributed. They are not first-party and
    // nobody can edit them, but the question here is how much of the bundle the
    // analysis could account for - and counting React as a gap would report ~0%
    // attribution on every app, which is a coverage metric that measures
    // nothing except how much framework a route ships.
    const attributed = total(route.modules) + total(route.dependencies)
    clientBytesTotal += attributed + route.unattributedBytes
    clientBytesAttributed += attributed
  }

  const unresolvedRelationships = measurable.reduce(
    (sum, route) => sum + (route.shell?.unknown.length ?? 0),
    0,
  )
  const conservativeModules = measurable.reduce((sum, route) => sum + route.conservativeModules, 0)

  return {
    routesTotal,
    routesClassified,
    shellsEmitted,
    shellsMeasured,
    clientBytesTotal,
    clientBytesAttributed,
    unresolvedRelationships,
    conservativeModules,
    confidence: confidenceFrom({
      routesTotal,
      routesClassified,
      shellsEmitted,
      shellsMeasured,
      clientBytesTotal,
      clientBytesAttributed,
    }),
  }
}

/**
 * Three ratios, evenly weighted: routes classified, shells measured, client
 * bytes attributed.
 *
 * Even weighting is a deliberate refusal to tune. Any other split would be a
 * claim about which gap matters most, and there is no evidence for such a claim
 * - so the counts stay visible and the weighting stays boring.
 *
 * A dimension with nothing to measure is skipped rather than scored zero. An
 * app where no route emitted a shell has not failed shell analysis; there was
 * no shell to analyse, and folding that in as a miss would report low
 * confidence in an answer that is completely solid.
 *
 * `unresolvedRelationships` deliberately does not enter the number. It has no
 * denominator - there is no total count of relationships a codebase contains -
 * and dividing by an invented one is the arbitrary score this avoids. It is
 * reported alongside so a reader can weigh it themselves.
 */
function confidenceFrom(counts: {
  routesTotal: number
  routesClassified: number
  shellsEmitted: number
  shellsMeasured: number
  clientBytesTotal: number
  clientBytesAttributed: number
}): number {
  const ratios: number[] = []

  if (counts.routesTotal > 0) ratios.push(counts.routesClassified / counts.routesTotal)
  if (counts.shellsEmitted > 0) ratios.push(counts.shellsMeasured / counts.shellsEmitted)
  if (counts.clientBytesTotal > 0) ratios.push(counts.clientBytesAttributed / counts.clientBytesTotal)

  if (ratios.length === 0) return 0
  const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length
  return Math.round(mean * 100) / 100
}

const total = (byKey: Record<string, number>): number =>
  Object.values(byKey).reduce((sum, bytes) => sum + bytes, 0)

/** `92% · 25/25 routes classified · 94% of client JS attributed` and friends. */
export function coverageLines(coverage: Coverage): string[] {
  const lines = [
    `${coverage.routesClassified}/${coverage.routesTotal} routes classified`,
    `${coverage.shellsMeasured}/${coverage.shellsEmitted} emitted shells measured`,
  ]

  if (coverage.clientBytesTotal > 0) {
    const share = Math.round((coverage.clientBytesAttributed / coverage.clientBytesTotal) * 100)
    lines.push(`${share}% of client JavaScript attributed`)
  }
  if (coverage.unresolvedRelationships > 0) {
    lines.push(`${coverage.unresolvedRelationships} unresolved component relationships`)
  }
  if (coverage.conservativeModules > 0) {
    lines.push(`${coverage.conservativeModules} modules analysed at file granularity`)
  }

  return lines
}
