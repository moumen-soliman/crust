import type { RouteSnapshot, Snapshot } from '../store/snapshot.ts'
import { parseReason, shortReason } from '../diff/reason.ts'

export interface Finding {
  /** Higher sorts first. See `RANK` for why the bands are where they are. */
  severity: number
  kind: 'dynamic' | 'shell' | 'size' | 'setup' | 'unknown'
  /** The route pattern this is about, or null for a project-wide finding. */
  route: string | null
  headline: string
  /** The evidence — a call site, a package name, a number. Null when there is none. */
  detail: string | null
  /** What to actually do about it. Never optional: a finding with no action is noise. */
  action: string
}

/**
 * A first run has no baseline, so it cannot talk about regressions — which is the
 * tool's real subject. What it can do is answer the question someone actually has
 * the first time they run it: *of everything in this build, what are the three
 * things worth my afternoon?*
 *
 * The bands below encode one opinion, applied consistently: a route that serves
 * no static HTML at all is worse than one that serves some, which is worse than
 * one that serves a lot of JavaScript, which is worse than a gap in crust's own
 * setup. Within a band, magnitude decides.
 */
const RANK = {
  fullyDynamic: 80,
  shellShrunk: 60,
  heavyRoute: 40,
  setup: 30,
  unknown: 20,
} as const

/**
 * The default ceiling used when no budget file says otherwise. It matches the
 * `defaultFirstLoadBytes` in the README's example budget so the zero-config
 * finding and the configured check agree about what "too big" means.
 */
const HEAVY_ROUTE_BYTES = 250_000

export function findingsFor(snapshot: Snapshot): Finding[] {
  const found: Finding[] = []
  const coverage = attributionCoverage(snapshot)

  for (const route of snapshot.routes) {
    if (route.renderingMode === 'ROUTE_HANDLER') continue
    found.push(...routeFindings(route, coverage))
  }

  found.push(...projectFindings(snapshot, coverage))
  return found.sort((a, b) => b.severity - a.severity)
}

interface Coverage {
  /** At least one chunk reported no source map. */
  anyChunkUnmapped: boolean
  /** The worst single route's unattributed share, 0..1. */
  worstShare: number
  /** The route that share belongs to, for reporting a real number. */
  worstRoute: RouteSnapshot | null
  /** Whether attribution is degraded badly enough to be worth telling anyone. */
  degraded: boolean
}

/**
 * Two signals, and both are needed.
 *
 * A single warning is not evidence of a misconfigured build: webpack's polyfill
 * chunk can ship without a map while `productionBrowserSourceMaps` is on, and
 * announcing "this build has no source maps" over one small chunk is a confident
 * false statement about the project's setup.
 *
 * A low coverage number is not evidence either. A real fixture attributes only
 * 45% of its bytes with maps fully enabled, because the rest maps into framework
 * internals rather than to any first-party file.
 *
 * Together they mean something: maps are missing *and* it cost real coverage.
 */
function attributionCoverage(snapshot: Snapshot): Coverage {
  const anyChunkUnmapped = snapshot.warnings.some((w) => w.includes('no source map emitted'))

  let worstShare = 0
  let worstRoute: RouteSnapshot | null = null
  for (const route of snapshot.routes) {
    if (route.firstLoadBytes === 0) continue
    const share = route.unattributedBytes / route.firstLoadBytes
    if (share > worstShare) {
      worstShare = share
      worstRoute = route
    }
  }

  return { anyChunkUnmapped, worstShare, worstRoute, degraded: anyChunkUnmapped && worstShare > 0.25 }
}

function routeFindings(route: RouteSnapshot, coverage: Coverage): Finding[] {
  const found: Finding[] = []

  if (route.renderingMode === 'DYNAMIC') {
    const reason = route.dynamicReasons[0] ?? null
    const parsed = reason ? parseReason(reason) : null
    found.push({
      // A dynamic route that is dynamic because of one uncached fetch is more
      // fixable — and more likely accidental — than one reading cookies, which is
      // usually a deliberate decision about personalised content.
      severity: RANK.fullyDynamic + (parsed?.kind === 'cache' ? 5 : 0),
      kind: 'dynamic',
      route: route.pattern,
      headline: 'renders on every request — nothing is served statically',
      detail: reason ? shortReason(reason) : null,
      action: parsed?.kind === 'cache'
        ? `Cache that read (\`use cache\`, or \`fetch(…, { next: { revalidate } })\`) and the route can prerender.`
        : parsed?.api
          ? `Move the \`${parsed.api}()\` read into a component inside \`<Suspense>\` so the rest of the page can prerender.`
          : 'Find what reads request state on this route; everything above it can prerender once it is isolated.',
    })
  }

  const ratio = route.shell?.actual?.shellRatio
  if (ratio !== undefined && ratio !== null && ratio < 0.9 && route.renderingMode !== 'DYNAMIC') {
    const hole = route.shell?.predictedHoles[0]
    const parsed = hole ? parseReason(hole.reason) : null
    found.push({
      // A 20% shell is a worse finding than an 85% one, and the gap scales it.
      severity: RANK.shellShrunk + Math.round((1 - ratio) * 19),
      kind: 'shell',
      route: route.pattern,
      headline: `only ${Math.round(ratio * 100)}% of this route is in the static shell`,
      detail: hole ? `${shortReason(hole.reason)} — in <${hole.component}>` : null,
      action: parsed?.kind === 'cache'
        ? `Add \`use cache\` above that read to pull <${hole!.component}> back into the shell.`
        : hole
          ? `<${hole.component}> is postponed by that call. Cache it, or accept the hole if the data must be per-request.`
          : 'The build emitted holes crust could not trace to a call site — run with source maps for the call site.',
    })
  }

  if (route.firstLoadBytes > HEAVY_ROUTE_BYTES) {
    found.push(sizeFinding(route, coverage))
  }

  if (route.renderingMode === 'unknown') {
    found.push({
      severity: RANK.unknown,
      kind: 'unknown',
      route: route.pattern,
      headline: 'crust could not determine why this route is not prerendered',
      detail: route.renderingModeReason,
      action: 'Reported as unknown rather than guessed. If this route matters, open an issue with its source — this is a gap in the analyzer.',
    })
  }

  return found
}

function projectFindings(snapshot: Snapshot, coverage: Coverage): Finding[] {
  const found: Finding[] = []

  if (coverage.degraded) {
    const worst = coverage.worstRoute
    found.push({
      // Below any real route problem, because it is about crust's own accuracy
      // rather than about the app — but above `unknown`, because it is the one
      // finding here with a one-line fix that improves every other finding.
      severity: RANK.setup,
      kind: 'setup',
      route: null,
      headline: 'per-file attribution is degraded — some chunks shipped without source maps',
      // Deliberately the worst single route rather than a project total. Routes
      // share chunks, so summing `unattributedBytes` across them counts the same
      // bytes once per route that loads them and invents a number larger than the
      // build.
      detail: worst
        ? `worst route \`${worst.pattern}\`: ${(worst.unattributedBytes / 1024).toFixed(0)} kB (${pct(coverage.worstShare)}) untraceable`
        : null,
      action: 'Set `productionBrowserSourceMaps: true` in next.config and rebuild. Route sizes and shell analysis are already accurate without it.',
    })
  }

  const unknowns = new Set(snapshot.routes.flatMap((r) => r.shell?.unknown ?? []))
  if (unknowns.size > 0) {
    found.push({
      severity: RANK.unknown - 1,
      kind: 'unknown',
      route: null,
      headline: `${unknowns.size} component${unknowns.size === 1 ? '' : 's'} could not be classified`,
      detail: [...unknowns][0] ?? null,
      action: 'These are reported as unknown rather than assumed static. `.perf/overrides.json` resolves import specifiers the resolver cannot.',
    })
  }

  return found
}

/**
 * The framework runtime. On a small app it is most of first-load JS and it is the
 * heaviest "dependency" on every single route — so blaming it produces a finding
 * that is simultaneously true, top-ranked, and impossible to act on. Nobody can
 * `next/dynamic` away React. It is reported as the floor it is, and blame moves to
 * the heaviest thing the author actually chose.
 */
const FRAMEWORK = new Set(['next', 'react', 'react-dom', 'scheduler', 'react-server-dom-webpack', 'react-server-dom-turbopack'])

/**
 * Below this share of the route, naming something as *the* reason it is heavy is
 * false precision. On a 543 kB route the largest package the author actually
 * chose can be 0.9 kB; "remove @swc/helpers" is a technically-correct answer to a
 * question nobody asked. If deleting it outright would not move the number by 5%,
 * it is not the answer.
 */
const WORTH_NAMING = 0.05

function sizeFinding(route: RouteSnapshot, coverage: Coverage): Finding {
  const severity = RANK.heavyRoute + Math.min(19, Math.round(route.firstLoadBytes / HEAVY_ROUTE_BYTES))
  const headline = `${(route.firstLoadBytes / 1024).toFixed(0)} kB of JavaScript on first load`
  const base = { severity, kind: 'size' as const, route: route.pattern, headline }

  const frameworkBytes = Object.entries(route.dependencies)
    .filter(([name]) => FRAMEWORK.has(name))
    .reduce((sum, [, bytes]) => sum + bytes, 0)

  const worst = heaviestContributor(route)
  const worthNaming = worst && worst.bytes / route.firstLoadBytes >= WORTH_NAMING

  // Whichever bucket is actually the bulk of the route is the one to talk about.
  // Ranking them by size rather than by which is easiest to explain is what keeps
  // this from confidently pointing at the wrong thing.
  if (worthNaming) {
    return {
      ...base,
      detail: `${worst.name} is ${(worst.bytes / 1024).toFixed(1)} kB of it${frameworkBytes > 0 ? `, on a ${(frameworkBytes / 1024).toFixed(0)} kB framework baseline` : ''}`,
      action: worst.isDependency
        ? `Check whether \`${worst.name}\` needs to be in the client bundle — a server component or a \`next/dynamic\` import removes it from first load.`
        : `\`${worst.name}\` is first-party. If it is only needed after interaction, \`next/dynamic\` takes it out of first load.`,
    }
  }

  if (route.unattributedBytes > frameworkBytes) {
    const share = pct(route.unattributedBytes / route.firstLoadBytes)
    return {
      ...base,
      detail: `${(route.unattributedBytes / 1024).toFixed(0)} kB of it (${share}) could not be traced to any source`,
      // The fix is only "turn on source maps" when a missing map is what actually
      // cost the coverage. Recommending a setting the project already has is how a
      // tool proves it did not look.
      action: coverage.degraded
        ? 'Set `productionBrowserSourceMaps: true` in next.config and rebuild — until then crust cannot say what those bytes are.'
        : 'These bytes map to no first-party file, so they are framework or vendor internals. There is no import here to remove.',
    }
  }

  // Framework-dominated and nothing the author added is large enough to name.
  // There is no import to delete here; the only honest action is to stop it
  // growing from where it is.
  return {
    ...base,
    detail: `${(frameworkBytes / 1024).toFixed(0)} kB is the framework baseline and nothing else on the route is over ${pct(WORTH_NAMING)} of it`,
    action: `Nothing here is worth removing. Set \`defaultFirstLoadBytes\` in \`.perf/budgets.json\` so this cannot grow past ${(route.firstLoadBytes / 1024).toFixed(0)} kB unnoticed.`,
  }
}

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`

/** The heaviest thing the author chose to add — never the framework itself. */
function heaviestContributor(route: RouteSnapshot): { name: string; bytes: number; isDependency: boolean } | null {
  const candidates = [
    ...Object.entries(route.dependencies)
      .filter(([name]) => !FRAMEWORK.has(name))
      .map(([name, bytes]) => ({ name, bytes, isDependency: true })),
    ...Object.entries(route.modules).map(([name, bytes]) => ({ name, bytes, isDependency: false })),
  ]
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.bytes > a.bytes ? b : a))
}
