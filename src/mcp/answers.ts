import { resolve as resolvePath } from 'node:path'
import { checkBudgets, readBudgets } from '../ci/budgets.ts'
import { findWorkspaceRoot } from '../core/workspace.ts'
import { readAliases } from '../diff/aliases.ts'
import { comparableBuilds, latestCompatibleBaseline } from '../diff/compatible.ts'
import { diffSnapshots } from '../diff/diff.ts'
import { buildLead } from '../diff/lead.ts'
import { findingsFor } from '../findings/findings.ts'
import { SnapshotStore } from '../store/store.ts'
import type { CauseChain, RouteSnapshot, Snapshot } from '../store/snapshot.ts'
import { CAP, cap, capMap, cite, coverageReport, refuse, type Capped, type Citation, type CoverageReport, type Refusal } from './caps.ts'

/**
 * The answers behind the MCP tools.
 *
 * Every function here is a query over `.perf/`, so this module imports nothing
 * that can build, analyse or write. That is not a convention to remember - it is
 * checked by a test that reads this file's imports, because "read-only" is the
 * one property an agent cannot verify for itself before calling a tool.
 *
 * The answers are shaped for a reader that will summarise them. That means the
 * evidence and its limits arrive together: a byte figure never travels without
 * the share of the build it came from, a missing conclusion is a value with a
 * reason rather than an absent key, and every answer names the build it came
 * from so a human can re-derive it with `crust diff` by hand.
 */

export interface Session {
  cwd: string
  root: string
  store: SnapshotStore
}

export async function openSession(cwd: string): Promise<Session> {
  const dir = resolvePath(cwd)
  const root = await findWorkspaceRoot(dir)
  return { cwd: dir, root, store: new SnapshotStore(root) }
}

/**
 * A named ref, or the newest snapshot in the store when the caller names none.
 *
 * The CLI's implicit head analyses the build sitting in `.next`. This never
 * does: an MCP tool that can start a production build is a multi-minute hang and
 * an arbitrary-command surface, so the head defaults to the newest thing already
 * recorded and says so when the store is empty.
 */
async function snapshotFor(session: Session, ref?: string): Promise<Snapshot | Refusal> {
  const stored = await session.store.list()
  if (stored.length === 0) {
    return refuse(
      `No snapshots are recorded in ${session.root}/.perf.`,
      'Run `crust analyze` on a production build first. This server only reads snapshots; it never builds.',
    )
  }

  if (ref === undefined) return stored[0]!

  const found = await session.store.resolve(ref, session.cwd, undefined, { exact: true })
  if (!found) {
    return refuse(
      `No stored snapshot matches "${ref}".`,
      `Call list_builds to see what is recorded, or run \`crust analyze\` on that commit. Refs resolve exactly - "${ref}" is not substituted with a nearby build.`,
    )
  }
  return found
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && (value as Refusal).ok === false
}

/**
 * A route, matched exactly.
 *
 * Exact on the URL pattern, then on the trend id, then on the source path - and
 * a refusal naming the candidates when none of the three hit. No nearest match:
 * approximate retrieval over exact data is how a tool answers a question about
 * `/blog/[slug]` with the numbers for `/blog`.
 */
function routeIn(snapshot: Snapshot, wanted: string): RouteSnapshot | Refusal {
  const found =
    snapshot.routes.find((route) => route.pattern === wanted) ??
    snapshot.routes.find((route) => route.id === wanted) ??
    snapshot.routes.find((route) => route.filePath === wanted)
  if (found) return found

  const patterns = cap(snapshot.routes.map((route) => route.pattern).sort(), CAP.patterns)
  return refuse(
    `Build ${snapshot.buildId} has no route "${wanted}".`,
    `Name one of its ${patterns.total} routes exactly${patterns.truncated ? ` (first ${patterns.items.length} shown)` : ''}: ${patterns.items.join(', ')}`,
  )
}

const byBytesDesc = <T>(bytes: (item: T) => number) => (a: T, b: T) => bytes(b) - bytes(a)

/** `{ 'react-dom': 40000 }` -> a capped, largest-first list. */
function entries(record: Record<string, number>, limit: number): Capped<{ name: string; bytes: number }> {
  const list = Object.entries(record)
    .map(([name, bytes]) => ({ name, bytes }))
    .sort(byBytesDesc((item) => item.bytes))
  return cap(list, limit)
}

// ---------------------------------------------------------------------------
// list_builds
// ---------------------------------------------------------------------------

export async function listBuilds(session: Session, input: { limit?: number } = {}): Promise<unknown> {
  const stored = await session.store.list()
  const limit = Math.min(input.limit ?? CAP.builds, CAP.builds)

  return {
    ok: true,
    store: `${session.root}/.perf`,
    builds: capMap(stored, limit, (snapshot) => ({
      ...cite(snapshot),
      committedAt: snapshot.committedAt,
      routeCount: snapshot.routes.length,
      schemaVersion: snapshot.schemaVersion,
      confidence: snapshot.coverage.confidence,
    })),
    note:
      stored.length === 0
        ? 'The store is empty. Run `crust analyze` on a production build; this server never builds.'
        : 'Newest first, by commit date. Any buildId, git sha or branch name here can be passed as `ref` to the other tools.',
  }
}

// ---------------------------------------------------------------------------
// build_summary
// ---------------------------------------------------------------------------

export async function buildSummary(session: Session, input: { ref?: string } = {}): Promise<unknown> {
  const head = await snapshotFor(session, input.ref)
  if (isRefusal(head)) return head

  // The same baseline `crust analyze` picks, so the verdict here is the verdict
  // the CLI printed for this build rather than a second opinion.
  const stored = await session.store.list()
  const base = latestCompatibleBaseline(head, stored)
  const aliases = await readAliases(session.root)
  const diff = base ? diffSnapshots(base, head, aliases) : null
  const breaches = checkBudgets(head, await readBudgets(session.root), diff)
  const lead = buildLead(head, diff, breaches)

  const worst = [...head.routes].sort(byBytesDesc((route) => route.firstLoadBytes))

  return {
    ok: true,
    build: cite(head),
    baseline: base ? cite(base) : null,
    decision: {
      ...lead.decision,
      // `undecidable` with no explanation reads as a tool failure rather than as
      // the honest answer it is.
      why: base ? null : 'No comparable baseline is stored, so nothing about this build can be called a regression.',
    },
    changes: cap(lead.changes, CAP.routes),
    causes: capMap(lead.causes, CAP.causes, (cause) => ({
      kind: cause.kind,
      label: cause.label,
      what: cause.what,
      routes: cap(cause.routes, CAP.routes),
      bytesPerRoute: cause.bytesPerRoute,
      component: cause.component,
      action: cause.action,
    })),
    heaviestRoutes: capMap(worst, CAP.routes, (route) => ({
      pattern: route.pattern,
      firstLoadBytes: route.firstLoadBytes,
      renderingMode: route.renderingMode,
      shellRatio: route.shell?.actual?.shellRatio ?? null,
      unattributedBytes: route.unattributedBytes,
    })),
    sharedCauses: capMap(head.sharedCauses, CAP.causes, (cause) => ({
      kind: cause.kind,
      label: cause.label,
      routeCount: cause.routes.length,
      routes: cap(cause.routes, CAP.routes),
      bytesPerRoute: cause.bytesPerRoute,
      bytesTotal: cause.bytesTotal,
      evidence: cause.evidence,
    })),
    budgetBreaches: capMap(breaches, CAP.routes, (breach) => ({
      pattern: breach.pattern,
      kind: breach.kind,
      message: breach.message,
      blame: breach.blame,
    })),
    coverage: coverageReport(head.coverage),
    warnings: cap(head.warnings, CAP.warnings),
    note: 'Verdict, causes and coverage are the same values `crust analyze` printed for this build.',
  }
}

// ---------------------------------------------------------------------------
// route_detail
// ---------------------------------------------------------------------------

export async function routeDetail(session: Session, input: { route: string; ref?: string }): Promise<unknown> {
  const snapshot = await snapshotFor(session, input.ref)
  if (isRefusal(snapshot)) return snapshot
  const route = routeIn(snapshot, input.route)
  if (isRefusal(route)) return route

  return {
    ok: true,
    build: cite(snapshot),
    route: {
      pattern: route.pattern,
      id: route.id,
      filePath: route.filePath,
      renderingMode: route.renderingMode,
      // The reason is the evidence for the mode; omitting it when null would let
      // "STATIC" and "unknown, and here is why" read the same.
      renderingModeReason: route.renderingModeReason ?? (route.renderingMode === 'unknown' ? 'unknown - crust could not classify this route' : null),
      layouts: cap(route.layouts, CAP.routes),
      config: route.config,
    },
    bytes: {
      firstLoad: route.firstLoadBytes,
      routeOnly: route.routeBytes,
      shared: route.sharedBytes,
      // Named rather than dropped: unattributed bytes are the part of this route
      // no finding below can be about.
      unattributed: route.unattributedBytes,
    },
    dependencies: entries(route.dependencies, CAP.dependencies),
    modules: entries(route.modules, CAP.modules),
    clientBoundaries: capMap([...route.clientBoundaries].sort(byBytesDesc((b) => b.bytes)), CAP.boundaries, (boundary) => ({
      file: boundary.file,
      component: boundary.component,
      bytes: boundary.bytes,
    })),
    barrels: capMap([...route.barrels].sort(byBytesDesc((b) => b.bytes)), CAP.barrels, (barrel) => ({
      file: barrel.file,
      bytes: barrel.bytes,
      dragged: cap(barrel.dragged, CAP.dragged),
    })),
    shell: route.shell
      ? {
          predictedStatic: cap(route.shell.predictedStatic, CAP.routes),
          predictedHoles: capMap(route.shell.predictedHoles, CAP.routes, (hole) => ({
            component: hole.component,
            boundary: hole.boundary,
            reason: hole.reason,
          })),
          actual: route.shell.actual,
          agreement: route.shell.agreement,
          unknown: cap(route.shell.unknown, CAP.routes),
        }
      : null,
    shellUnavailableReason: route.shell ? null : 'This build emitted no readable shell for this route, so its static/dynamic split is unmeasured.',
    conservativeModules: route.conservativeModules,
    warnings: cap(route.warnings, CAP.warnings),
    coverage: coverageReport(snapshot.coverage),
  }
}

// ---------------------------------------------------------------------------
// explain_route_cause
// ---------------------------------------------------------------------------

function chain(link: CauseChain): unknown {
  return {
    entryFile: link.entryFile,
    component: link.component,
    site: link.site,
    detail: link.detail,
    evidence: link.evidence,
    // The whole point of `unknown` evidence: the chain stops somewhere, and
    // where it stops is the finding.
    unresolved: link.unresolved,
    links: capMap(link.links, CAP.links, (hop) => ({
      file: hop.file,
      binding: hop.binding,
      via: hop.via,
      barrel: hop.barrel,
      component: hop.component,
    })),
  }
}

export async function explainRouteCause(session: Session, input: { route: string; ref?: string }): Promise<unknown> {
  const snapshot = await snapshotFor(session, input.ref)
  if (isRefusal(snapshot)) return snapshot
  const route = routeIn(snapshot, input.route)
  if (isRefusal(route)) return route

  return {
    ok: true,
    build: cite(snapshot),
    route: route.pattern,
    renderingMode: route.renderingMode,
    renderingModeReason: route.renderingModeReason,
    dynamicReasons: cap(route.dynamicReasons, CAP.causes),
    chains: capMap(route.causes, CAP.chains, chain),
    // A static route has no chains, and so does a route whose chains crust could
    // not build. Those are different answers and must not collapse.
    noChainsReason:
      route.causes.length > 0
        ? null
        : route.dynamicReasons.length > 0
          ? 'This route is dynamic, but crust could not assemble a source chain for it. The reasons above are the evidence it does have.'
          : route.renderingMode === 'unknown'
            ? 'crust could not classify this route, so it has no cause chain. Treat its rendering mode as unmeasured.'
            : 'This route is not dynamic, so there is no cause to explain.',
    conservativeModules: route.conservativeModules,
    coverage: coverageReport(snapshot.coverage),
    legend: {
      verified: 'an emitted build artifact agrees',
      inferred: 'source relationships support it; no artifact confirms it',
      unknown: 'the chain has a gap, and crust refuses to guess across it',
    },
  }
}

// ---------------------------------------------------------------------------
// compare_builds
// ---------------------------------------------------------------------------

export async function compareBuilds(session: Session, input: { base: string; head?: string }): Promise<unknown> {
  const head = await snapshotFor(session, input.head)
  if (isRefusal(head)) return head

  // `head` is passed so a commit holding several snapshots yields one this build
  // can actually be compared against, matching `crust diff`.
  const base = await session.store.resolve(input.base, session.cwd, head, { exact: true })
  if (!base) {
    const stored = await session.store.list()
    if (session.store.isSelfBaseline(input.base, head, stored)) {
      return refuse(
        `"${input.base}" is the same build as the head (${head.buildId}).`,
        'A build cannot be compared to itself. Name an older buildId from list_builds.',
      )
    }
    return refuse(
      `No stored snapshot matches base "${input.base}".`,
      'Call list_builds to see what is recorded, or run `crust analyze` on that commit. This server never builds.',
    )
  }

  if (!comparableBuilds(base, head)) {
    return refuse(
      `Builds ${base.buildId} and ${head.buildId} are not safely comparable.`,
      'They differ in schema version, bundler or Next major. Comparing them would report framework differences as code regressions. Pick a pair from the same toolchain.',
    )
  }

  const aliases = await readAliases(session.root)
  const diff = diffSnapshots(base, head, aliases)
  const breaches = checkBudgets(head, await readBudgets(session.root), diff)
  const lead = buildLead(head, diff, breaches)

  const moved = diff.routes.filter((route) => route.severity !== 'neutral')

  return {
    ok: true,
    base: cite(base),
    head: cite(head),
    decision: lead.decision,
    changes: cap(lead.changes, CAP.routes),
    causes: capMap(lead.causes, CAP.causes, (cause) => ({
      kind: cause.kind,
      label: cause.label,
      what: cause.what,
      routes: cap(cause.routes, CAP.routes),
      bytesPerRoute: cause.bytesPerRoute,
      component: cause.component,
      action: cause.action,
    })),
    routes: capMap([...moved].sort(byBytesDesc((route) => Math.abs(route.firstLoadDelta))), CAP.routes, (route) => ({
      pattern: route.pattern,
      status: route.status,
      severity: route.severity,
      firstLoadBefore: route.firstLoadBefore,
      firstLoadAfter: route.firstLoadAfter,
      firstLoadDelta: route.firstLoadDelta,
      shellRatioDelta: route.shellRatioDelta,
      renderingModeBefore: route.renderingModeBefore,
      renderingModeAfter: route.renderingModeAfter,
      cause: route.cause,
    })),
    dependencies: capMap(diff.dependencies, CAP.dependencies, (dep) => ({
      pkg: dep.pkg,
      status: dep.status,
      delta: dep.delta,
      before: dep.before,
      after: dep.after,
      routes: cap(dep.routes, CAP.routes),
    })),
    clientBoundaries: capMap(diff.clientBoundaries, CAP.boundaries, (boundary) => ({
      file: boundary.file,
      component: boundary.component,
      status: boundary.status,
      delta: boundary.delta,
      routes: cap(boundary.routes, CAP.routes),
    })),
    barrels: capMap(diff.barrels, CAP.barrels, (barrel) => ({
      file: barrel.file,
      status: barrel.status,
      delta: barrel.delta,
      newlyDragged: cap(barrel.newlyDragged, CAP.dragged),
      routes: cap(barrel.routes, CAP.routes),
    })),
    configChanges: cap(diff.configChanges, CAP.causes),
    budgetBreaches: capMap(breaches, CAP.routes, (breach) => ({
      pattern: breach.pattern,
      kind: breach.kind,
      message: breach.message,
      blame: breach.blame,
    })),
    // A per-route byte delta means nothing without knowing what share of the
    // build those bytes are. `lead.coverage` is null when neither side had client
    // JS, which is a different statement from "100% attributed".
    coverage: coverageReport(head.coverage),
    attributionNote: lead.coverage ? lead.coverage.text : 'Neither build had client JavaScript to attribute.',
    attributionWeak: lead.coverage?.weak ?? false,
    note: `Equivalent to \`crust diff ${base.buildId} ${head.buildId}\`.`,
  }
}

// ---------------------------------------------------------------------------
// cause_blast_radius
// ---------------------------------------------------------------------------

interface Reach {
  pattern: string
  bytes: number | null
  how: 'dependency' | 'client-boundary' | 'barrel' | 'layout' | 'shared-cause'
}

/**
 * Which routes one package, boundary, barrel or layout reaches.
 *
 * Answered from the snapshot's own `sharedCauses` when it names the key, and by
 * scanning the routes when it does not - a cause that reaches a single route is
 * absent from `sharedCauses` by design, and "no shared cause" is the wrong answer
 * to "which routes does this affect".
 */
export async function causeBlastRadius(session: Session, input: { cause: string; ref?: string }): Promise<unknown> {
  const snapshot = await snapshotFor(session, input.ref)
  if (isRefusal(snapshot)) return snapshot

  const key = input.cause
  const shared = snapshot.sharedCauses.filter((cause) => cause.key === key || cause.label === key)

  const reached: Reach[] = []
  for (const route of snapshot.routes) {
    const dependency = route.dependencies[key]
    if (dependency !== undefined) reached.push({ pattern: route.pattern, bytes: dependency, how: 'dependency' })

    const boundary = route.clientBoundaries.find((item) => item.file === key || item.component === key)
    if (boundary) reached.push({ pattern: route.pattern, bytes: boundary.bytes, how: 'client-boundary' })

    const barrel = route.barrels.find((item) => item.file === key)
    if (barrel) reached.push({ pattern: route.pattern, bytes: barrel.bytes, how: 'barrel' })

    if (route.layouts.includes(key)) reached.push({ pattern: route.pattern, bytes: null, how: 'layout' })
  }

  for (const cause of shared) {
    for (const pattern of cause.routes) {
      if (reached.some((hit) => hit.pattern === pattern)) continue
      reached.push({ pattern, bytes: cause.bytesPerRoute, how: 'shared-cause' })
    }
  }

  if (reached.length === 0) {
    return refuse(
      `Nothing in build ${snapshot.buildId} is named "${key}".`,
      'Pass a package name, a `use client` file path, a barrel file path, a layout path, or a sharedCauses key exactly as build_summary or route_detail reports it.',
    )
  }

  const sorted = [...reached].sort(byBytesDesc((hit) => hit.bytes ?? 0))

  return {
    ok: true,
    build: cite(snapshot),
    cause: key,
    routeCount: reached.length,
    routes: cap(sorted, CAP.routes),
    // Never a sum across routes: a shared chunk counts in the first load of every
    // route it serves, so adding them invents bytes nobody downloads.
    worstRouteBytes: sorted[0]?.bytes ?? null,
    sharedCauses: capMap(shared, CAP.causes, (cause) => ({
      kind: cause.kind,
      label: cause.label,
      bytesPerRoute: cause.bytesPerRoute,
      bytesTotal: cause.bytesTotal,
      component: cause.component,
      introducedBy: cause.introducedBy,
      evidence: cause.evidence,
    })),
    coverage: coverageReport(snapshot.coverage),
    note: 'Bytes are per route, attributed. `worstRouteBytes` is the single worst route, never a total across routes.',
  }
}

// ---------------------------------------------------------------------------
// route_history
// ---------------------------------------------------------------------------

export async function routeHistory(session: Session, input: { route: string; ref?: string; limit?: number }): Promise<unknown> {
  const snapshot = await snapshotFor(session, input.ref)
  if (isRefusal(snapshot)) return snapshot
  const route = routeIn(snapshot, input.route)
  if (isRefusal(route)) return route

  const limit = Math.min(input.limit ?? CAP.history, CAP.history)
  // Compatibility-filtered against this build: a trend that silently mixes
  // bundlers or Next majors is a chart of the toolchain, not of the route.
  const history = await session.store.routeHistory(limit, snapshot)
  const series = history.get(route.id) ?? []

  const bytes = series.map((point) => point.bytes)
  const first = bytes[0]
  const last = bytes[bytes.length - 1]

  return {
    ok: true,
    build: cite(snapshot),
    route: route.pattern,
    routeId: route.id,
    // Oldest first, as the store returns it.
    points: capMap(series, limit, (point) => ({
      buildId: point.buildId,
      bytes: point.bytes,
      shellRatio: point.shellRatio,
    })),
    trend:
      series.length < 2
        ? null
        : {
            firstLoadDelta: last! - first!,
            min: Math.min(...bytes),
            max: Math.max(...bytes),
            samples: series.length,
          },
    trendUnavailableReason:
      series.length >= 2
        ? null
        : `Only ${series.length} comparable snapshot(s) record this route, so there is no trend yet. History is filtered to the same schema, bundler and Next major as ${snapshot.buildId}.`,
    coverage: coverageReport(snapshot.coverage),
  }
}

// ---------------------------------------------------------------------------
// build_findings
// ---------------------------------------------------------------------------

export async function buildFindings(session: Session, input: { ref?: string; limit?: number } = {}): Promise<unknown> {
  const snapshot = await snapshotFor(session, input.ref)
  if (isRefusal(snapshot)) return snapshot

  const limit = Math.min(input.limit ?? CAP.findings, CAP.findings)
  const found = findingsFor(snapshot)
  const coverage = coverageReport(snapshot.coverage)

  return {
    ok: true,
    build: cite(snapshot),
    findings: capMap(found, limit, (finding) => ({
      severity: finding.severity,
      kind: finding.kind,
      route: finding.route,
      headline: finding.headline,
      detail: finding.detail,
      action: finding.action,
    })),
    // An empty list under weak attribution is "not measured", and the caveat that
    // says so is already on `coverage` - repeated here because this is the tool
    // whose empty answer is most likely to be read as "nothing is wrong".
    emptyMeans:
      found.length > 0
        ? null
        : coverage.caveat ??
          'crust found nothing worth flagging in this build. Coverage below is what that conclusion rests on.',
    coverage,
    note: 'Deterministic: these are ranked by crust’s own severity bands, not generated. Same values as the first-run summary `crust analyze` prints.',
  }
}
