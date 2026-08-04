import { Box, Text, renderToString } from 'ink'
import { causeChainLines, isBytesChain } from '../analyze/cause.ts'
import { coverageLines } from '../analyze/coverage.ts'
import { kb, pct, signed } from '../ci/budgets.ts'
import type { Breach } from '../ci/budgets.ts'
import type { ConfigChange } from '../analyze/config.ts'
import { fullyExplained, type Diff, type RouteDelta } from '../diff/diff.ts'
import {
  buildLead,
  coveredBySite,
  explainedByCauses,
  type DecisionLevel,
  type Lead,
  type LeadCause,
  type LeadChange,
} from '../diff/lead.ts'
import { modeLabel as plainModeLabel } from '../diff/mode.ts'
import { findingsFor, type Finding } from '../findings/findings.ts'
import type { CauseChain, Coverage, RouteSnapshot, SharedCause, Snapshot } from '../store/snapshot.ts'
import { BarChart, Section, Table, colors, type BarChartItem, type TableColumn } from './primitives.tsx'

const MIN_WIDTH = 52
const MAX_WIDTH = 120
const DEFAULT_WIDTH = 96

export interface SnapshotTerminalOptions {
  diff?: Diff | null
  breaches?: Breach[]
  showRoutes?: boolean
  verbose?: boolean
  reportPath?: string | null
}

export function renderSnapshotTerminal(
  snapshot: Snapshot,
  optionsOrColumns: SnapshotTerminalOptions | number = {},
  columns = process.stdout.columns,
): string {
  const options = typeof optionsOrColumns === 'number' ? {} : optionsOrColumns
  if (typeof optionsOrColumns === 'number') columns = optionsOrColumns
  const width = terminalWidth(columns)
  return renderToString(<SnapshotView snapshot={snapshot} options={options} width={width} />, { columns: width })
}

export interface DiffTerminalOptions {
  /**
   * Budget breaches, when the caller loaded a budget file. `diff` passes them so
   * its decision is the one `ci` would reach on the same pair - a local run that
   * says "2 routes grew" where CI says "1 budget breach" is two tools.
   */
  breaches?: Breach[]
}

export function renderDiffTerminal(
  diff: Diff,
  optionsOrColumns: DiffTerminalOptions | number = {},
  columns = process.stdout.columns,
): string {
  const options = typeof optionsOrColumns === 'number' ? {} : optionsOrColumns
  if (typeof optionsOrColumns === 'number') columns = optionsOrColumns
  const width = terminalWidth(columns)
  return renderToString(<DiffView diff={diff} options={options} width={width} />, { columns: width })
}

function SnapshotView({ snapshot, options, width }: { snapshot: Snapshot; options: SnapshotTerminalOptions; width: number }) {
  const findings = findingsFor(snapshot)
  const diffRoutes = options.diff?.routes.filter((route) => route.status !== 'unchanged') ?? []
  const regressions = diffRoutes.filter((route) => route.severity === 'regression')
  const improvements = diffRoutes.filter((route) => route.severity === 'improvement')
  const topModules = Object.entries(snapshot.modules).sort((a, b) => b[1] - a[1]).slice(0, options.verbose ? 5 : 1)
  const routeWidth = Math.max(10, width - 42)
  const routeColumns: TableColumn<RouteSnapshot>[] = [
    { header: 'Route', width: routeWidth, value: (route) => route.pattern },
    { header: 'First load', width: 10, align: 'right', value: (route) => kb(route.firstLoadBytes) },
    { header: 'Shell', width: 6, align: 'right', value: (route) => shellRatio(route) },
    { header: 'Mode', width: 10, value: (route) => modeText(route.renderingMode) },
  ]
  const notes = snapshot.routes.filter(
    (route) =>
      (route.renderingModeReason && route.renderingMode !== 'STATIC') ||
      (route.shell?.predictedHoles.length ?? 0) > 0,
  )
  const unknowns = [...new Set(snapshot.routes.flatMap((route) => route.shell?.unknown ?? []))]
  // Rendering causes only. A byte chain is a report artefact - it needs the
  // sizes beside it to mean anything, and the terminal has no room for both.
  const chains = snapshot.routes
    .flatMap((route) => route.causes)
    .filter((cause) => !isBytesChain(cause))
    .slice(0, options.verbose ? 8 : 2)
  // One root cause beats the same finding repeated per route, so this sits
  // above the per-route chains rather than beside them.
  const shared = snapshot.sharedCauses.slice(0, options.verbose ? 8 : 3)
  const configChanges = options.diff?.configChanges ?? []

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" width={width}>
        <Text bold color={colors.accent}>crust — {snapshot.routes.length} routes</Text>
        <Text color={colors.muted}>Next {snapshot.nextVersion} · {snapshot.bundler}</Text>
      </Box>
      <Section title="BUILD HEALTH">
        <Text>{healthSummary(snapshot.routes)}</Text>
        <Text>Median first load: <Text bold>{humanBytes(medianFirstLoad(snapshot.routes))}</Text></Text>
        <Text>
          {options.diff
            ? `${diffRoutes.length} route${diffRoutes.length === 1 ? '' : 's'} changed since previous build (${shortBuild(options.diff.base.buildId)})`
            : 'No compatible local baseline — this build is the starting point'}
        </Text>
        <Text color={confidenceColor(snapshot.coverage.confidence)}>
          Analysis confidence: <Text bold>{Math.round(snapshot.coverage.confidence * 100)}%</Text>
          <Text color={colors.muted}> ({snapshot.coverage.routesClassified}/{snapshot.coverage.routesTotal} routes classified)</Text>
        </Text>
        <Text color={(options.breaches?.length ?? 0) > 0 ? colors.danger : options.diff ? colors.success : colors.warning}>
          CI → {(options.breaches?.length ?? 0) > 0
            ? `fail (${options.breaches!.length} breach${options.breaches!.length === 1 ? '' : 'es'})`
            : options.diff ? 'pass' : 'regression checks need a baseline'}
        </Text>
      </Section>
      {regressions.length > 0
        ? <RegressionFindings routes={regressions} />
        : findings.length > 0 ? <Findings findings={findings} /> : (
          <Section title="FIX FIRST"><Text color={colors.success}>✓ No actionable regressions found.</Text></Section>
        )}
      {topModules.length > 0 ? (
        <Section title="LARGEST CLIENT CONTRIBUTOR" {...(options.verbose ? { hint: 'first-party source files' } : {})}>
          {topModules.map(([file, bytes]) => <Text key={file}>{file} — <Text bold>{kb(bytes)}</Text></Text>)}
        </Section>
      ) : null}
      {options.diff ? (
        <Box marginTop={1}>
          <Text color={regressions.length > 0 ? colors.danger : colors.muted}>{regressions.length} regressions</Text>
          <Text color={colors.muted}> · </Text>
          <Text color={improvements.length > 0 ? colors.success : colors.muted}>{improvements.length} improvements</Text>
        </Box>
      ) : null}
      {options.showRoutes || options.verbose ? (
        <Section title="ROUTES" hint={modeSummary(snapshot.routes)}>
          <Table rows={snapshot.routes} columns={routeColumns} maxRows={60} />
        </Section>
      ) : <Text color={colors.muted}>Routes → crust analyze --routes</Text>}
      {configChanges.length > 0 ? <ConfigChanges changes={configChanges} /> : null}
      {shared.length > 0 ? <SharedCauses causes={shared} /> : null}
      {chains.length > 0 ? <CauseChains chains={chains} verbose={options.verbose ?? false} /> : null}
      {options.verbose ? <CoverageDetail coverage={snapshot.coverage} /> : null}
      {options.verbose && notes.length > 0 ? <RouteNotes routes={notes} /> : null}
      {options.verbose && unknowns.length > 0 ? <Unknowns unknowns={unknowns} /> : null}
      {options.verbose && snapshot.warnings.length > 0 ? <Warnings warnings={snapshot.warnings} /> : null}
      {options.reportPath
        ? <Text color={colors.muted}>Report → {options.reportPath}</Text>
        : <Text color={colors.muted}>Report → crust analyze --report</Text>}
    </Box>
  )
}

/**
 * The source relationship behind each conclusion, arrow per hop.
 *
 * Trimmed in the middle rather than truncated at the end: the two hops that
 * matter are the component someone recognises and the call they have to change,
 * and those sit at opposite ends of the chain.
 */
function CauseChains({ chains, verbose }: { chains: CauseChain[]; verbose: boolean }) {
  return (
    <Section title="WHY" hint="route → component → import → call site">
      {chains.map((chain, index) => {
        const lines = causeChainLines(chain)
        const shown = verbose || lines.length <= 5 ? lines : [...lines.slice(0, 2), '…', ...lines.slice(-2)]
        return (
          <Box key={`${chain.route}:${chain.site ?? index}`} flexDirection="column" marginBottom={1}>
            {shown.map((line, hop) => (
              <Text key={hop} color={hop === 0 ? colors.accent : colors.muted}>
                {hop === 0 ? '' : '  → '}
                <Text bold={hop === 0 || hop === shown.length - 1}>{line}</Text>
              </Text>
            ))}
            <Text color={chain.evidence === 'verified' ? colors.success : colors.warning}>
              {'  '}{chain.evidence}
            </Text>
          </Box>
        )
      })}
    </Section>
  )
}

/**
 * One root cause with its reach, rather than the same finding once per route.
 * A provider in the root layout is one line here and twenty lines in the route
 * table, and only one of those readings leads anyone to fix it.
 */
function SharedCauses({ causes }: { causes: SharedCause[] }) {
  return (
    <Section title="SHARED CAUSES" hint="one root cause, every route it reaches">
      {causes.map((cause) => (
        <Box key={`${cause.kind}:${cause.key}`} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold>{cause.label}</Text>
            <Text color={colors.muted}>
              {cause.bytesPerRoute !== null ? ` adds ${kb(cause.bytesPerRoute)} to ` : ' affects '}
              {cause.routes.length} routes
            </Text>
          </Text>
          {cause.introducedBy ? <Text color={colors.muted}>{'  '}Introduced by: {cause.introducedBy}</Text> : null}
          <Text color={colors.muted}>{'  '}{cause.routes.slice(0, 4).join(', ')}{cause.routes.length > 4 ? `, +${cause.routes.length - 4} more` : ''}</Text>
        </Box>
      ))}
    </Section>
  )
}

/**
 * Build configuration moves before application code does.
 *
 * Turning on Cache Components changes rendering on every route without a line
 * of app code changing, and a reviewer who reads the route table first will
 * conclude the PR broke twenty pages. This section exists to be read first.
 */
function ConfigChanges({ changes }: { changes: ConfigChange[] }) {
  return (
    <Section title="BUILD CONFIGURATION CHANGED" hint="not application code">
      {changes.slice(0, 6).map((change) => (
        <Box key={change.key} flexDirection="column">
          <Text bold color={change.incomparable ? colors.warning : colors.accent}>{change.summary}</Text>
          <Text color={colors.muted}>{'  '}Explains: {change.explains}</Text>
        </Box>
      ))}
    </Section>
  )
}

const DECISION_LABEL: Record<DecisionLevel, string> = {
  block: 'BLOCK',
  review: 'REVIEW',
  clear: 'CLEAR',
  undecidable: 'CANNOT DECIDE',
}

const decisionColor = (level: DecisionLevel): string =>
  level === 'block' ? colors.danger : level === 'review' ? colors.warning : level === 'clear' ? colors.success : colors.muted

/**
 * The answer, first, in the words the PR comment uses for the same pair.
 *
 * `crust diff` used to open with three counts, which is inventory: a reviewer had
 * to read the route table to find out whether anything mattered. The counts are
 * still on the header line; this is the sentence.
 */
function Decision({ lead }: { lead: Lead }) {
  return (
    <Section title="DECISION" hint={DECISION_LABEL[lead.decision.level]}>
      <Text color={decisionColor(lead.decision.level)} bold>
        {lead.decision.headline}
      </Text>
      {lead.coverage?.weak ? (
        <Text color={colors.warning}>
          {lead.coverage.text} - causes below are what could be traced
          {lead.coverage.missing ? `; missing ${lead.coverage.missing}` : ''}
        </Text>
      ) : null}
    </Section>
  )
}

/**
 * The changes that drove the decision, worst first, with improvements kept in the
 * same list rather than in a footnote - "nine routes got smaller" is the evidence
 * that a refactor worked, and it belongs where the regressions are.
 *
 * Each line carries the strongest source location available and, for regressions,
 * the likely next action. A finding that names a call site and stops leaves the
 * reader to work out the fix from a file path.
 */
function Changes({ changes }: { changes: LeadChange[] }) {
  return (
    <Section title="CHANGES" hint="worst first, improvements included">
      {changes.map((change, index) => (
        <Box key={`${change.direction}:${change.route}`} flexDirection="column" marginBottom={index < changes.length - 1 ? 1 : 0}>
          <Text>
            <Text bold color={change.direction === 'regression' ? colors.danger : colors.success}>
              {change.direction === 'regression' ? '✗ ' : '✓ '}
            </Text>
            <Text color={colors.accent}>{change.route}</Text>
            <Text>  {change.headline}</Text>
          </Text>
          {change.where ? <Text color={colors.muted}>{'    '}{change.where}</Text> : null}
          {change.action ? <Text color={colors.muted}>{'    '}→ {change.action}</Text> : null}
        </Box>
      ))}
    </Section>
  )
}

/** Causes named on a line before the rest collapse to a count, across all axes. */
const CAUSE_LIMIT = 8
/** Affected routes named on a cause line before it says "+N more". */
const CAUSE_ROUTE_LIMIT = 3

const CAUSE_KIND: Record<LeadCause['kind'], string> = {
  package: 'package',
  boundary: 'client boundary',
  barrel: 'barrel',
  site: 'call site',
}

/**
 * One cause, one line, with the routes it reached - above the route table because
 * a named cause is the decision a reviewer makes, where the same movement spread
 * down a byte column is several numbers and no decision.
 *
 * Every axis shares this section and its cap, so comparing another one cannot make
 * the output longer. The section is absent rather than empty when nothing could be
 * attributed; why it can be absent is on the header line: attribution.
 */
function Causes({ causes }: { causes: LeadCause[] }) {
  const shown = causes.slice(0, CAUSE_LIMIT)
  const hidden = causes.length - shown.length
  return (
    <Section title="CAUSES" hint={`${causes.length} found  ·  worst route, not the sum`}>
      {shown.map((cause) => {
        const named = cause.routes.slice(0, CAUSE_ROUTE_LIMIT).join(', ')
        const rest = cause.routes.length - CAUSE_ROUTE_LIMIT
        // A call site's `what` already names the site, so it is the subject; a
        // boundary's component is what a reviewer recognises, not its file.
        const subject =
          cause.kind === 'site'
            ? cause.what
            : cause.kind === 'boundary' && cause.component
              ? `<${cause.component}>`
              : cause.label
        return (
          <Box key={`${cause.kind}:${cause.label}`} marginBottom={1}>
            <Text color={(cause.bytesPerRoute ?? 0) > 0 ? colors.danger : cause.bytesPerRoute === null ? colors.warning : colors.success}>
              {(cause.bytesPerRoute === null ? '' : signed(cause.bytesPerRoute)).padStart(10)}
              {'  '}
            </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Text>
                <Text bold>{subject}</Text>
                <Text color={colors.muted}>
                  {cause.kind === 'site' ? '' : ` ${cause.what}`}  ·  {CAUSE_KIND[cause.kind]}
                </Text>
              </Text>
              <Text color={colors.muted}>
                {named}{rest > 0 ? `, +${rest} more` : ''}
                {cause.routes.length > 1 ? `  (${cause.routes.length} routes)` : ''}
              </Text>
              {cause.action ? <Text color={colors.muted}>→ {cause.action}</Text> : null}
            </Box>
          </Box>
        )
      })}
      {hidden > 0 ? <Text color={colors.muted}>+ {hidden} more cause{hidden === 1 ? '' : 's'}</Text> : null}
    </Section>
  )
}

// The attribution figure moved to `diff/lead.ts` when the PR comment needed the
// same number: two implementations of "how much of this build can we explain" is
// one more than a reader can be asked to reconcile.

function CoverageDetail({ coverage }: { coverage: Coverage }) {
  return (
    <Section title="ANALYSIS CONFIDENCE" hint={`${Math.round(coverage.confidence * 100)}%`}>
      {coverageLines(coverage).map((line) => <Text key={line} color={colors.muted}>{line}</Text>)}
    </Section>
  )
}

const confidenceColor = (confidence: number): string =>
  confidence >= 0.9 ? colors.success : confidence >= 0.7 ? colors.warning : colors.danger

function RegressionFindings({ routes }: { routes: RouteDelta[] }) {
  return (
    <Section title="FIX FIRST" hint={`${routes.length} regression${routes.length === 1 ? '' : 's'}`}>
      {routes.slice(0, 3).map((route, index) => (
        <Box key={route.id} flexDirection="column" marginBottom={index < Math.min(3, routes.length) - 1 ? 1 : 0}>
          <Text><Text bold color={colors.danger}>{index + 1}. </Text><Text color={colors.accent}>{route.pattern}</Text> {regressionHeadline(route)}</Text>
          {route.cause ? <Text color={colors.muted}>   Cause: {route.cause.what}</Text> : null}
          {route.cause?.component ? <Text color={colors.muted}>   Introduced by: &lt;{route.cause.component}&gt;</Text> : null}
          {shellMoved(route) ? <Text color={colors.muted}>   Shell: {shellNarrative(route)}</Text> : null}
          {route.modules[0] ? <Text color={colors.muted}>   JavaScript: {route.modules[0].file} {signed(route.modules[0].delta)}</Text> : null}
        </Box>
      ))}
      {routes.length > 3 ? <Text color={colors.muted}>+ {routes.length - 3} more in `crust diff`</Text> : null}
    </Section>
  )
}

function DiffView({ diff, options, width }: { diff: Diff; options: DiffTerminalOptions; width: number }) {
  const changed = diff.routes.filter((route) => route.status !== 'unchanged')
  // The same five things the PR comment leads with, from the same module.
  const lead = buildLead(diff.head, diff, options.breaches ?? [])
  // Only the findings that get a line can stand in for route detail; the ones
  // behind "+N more causes" explain nothing a reader can see.
  const shownCauses = lead.causes.slice(0, CAUSE_LIMIT)
  const siteCauses = shownCauses.filter((cause) => cause.kind === 'site')
  const explained = explainedByCauses(shownCauses)
  // Routes whose cause is already stated above - in the lead, in full, or by a
  // shared cause line covering all of them - do not get a second paragraph below
  // saying less.
  const stated = new Set([...lead.changes.map((change) => change.route), ...coveredBySite(siteCauses)])
  const regressions = changed.filter((route) => route.severity === 'regression').length
  const improvements = changed.filter((route) => route.severity === 'improvement').length
  const chartItems: BarChartItem[] = changed
    .filter((route) => Math.abs(route.firstLoadDelta) > 0)
    .sort((a, b) => Math.abs(b.firstLoadDelta) - Math.abs(a.firstLoadDelta))
    .slice(0, 8)
    .map((route) => ({
      label: route.pattern,
      value: Math.abs(route.firstLoadDelta),
      displayValue: signed(route.firstLoadDelta),
      color: route.firstLoadDelta > 0 ? colors.danger : colors.success,
    }))
  const columns: TableColumn<RouteDelta>[] = width < 86
    ? [
        { header: 'Route', width: Math.max(10, width - 28), value: (route) => route.pattern },
        { header: 'First', width: 9, align: 'right', value: (route) => kb(route.firstLoadAfter) },
        { header: 'Delta', width: 9, align: 'right', value: (route) => deltaText(route) },
      ]
    : [
        { header: 'Route', width: Math.max(10, width - 62), value: (route) => route.pattern },
        { header: 'First load', width: 10, align: 'right', value: (route) => kb(route.firstLoadAfter) },
        { header: 'Delta', width: 10, align: 'right', value: (route) => deltaText(route) },
        { header: 'Shell', width: 11, value: (route) => shellChange(route) },
        { header: 'Mode', width: 15, value: (route) => modeChange(route) },
      ]

  // An incomparable pair still produces numbers, and they are worse than no
  // numbers: a shell column reading `—→0%` is the baseline having no shell data
  // at all, not a shell that collapsed. Printing a regression count under a
  // banner that says the comparison is invalid is how a check teaches people to
  // scroll past its warnings, so the deltas are withheld rather than annotated.
  if (diff.incomparable.length > 0) {
    return (
      <Box flexDirection="column">
        <Header
          command="diff"
          id={`${snapshotLabel(diff.base)} → ${snapshotLabel(diff.head)}`}
          meta="not comparable"
          width={width}
        />
        <Section title="CANNOT COMPARE THESE BUILDS">
          {diff.incomparable.map((reason) => <Text key={reason} color={colors.warning}>! {reason}</Text>)}
        </Section>
        {diff.configChanges.length > 0 ? <ConfigChanges changes={diff.configChanges} /> : null}
        <Box marginTop={1}>
          <Text color={colors.muted}>
            {changed.length} route{changed.length === 1 ? '' : 's'} differ, but the difference cannot be attributed to
            this change. Deltas withheld.
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header
        command="diff"
        id={`${snapshotLabel(diff.base)} → ${snapshotLabel(diff.head)}`}
        meta={[
          `${changed.length} changed`,
          `${regressions} regression${regressions === 1 ? '' : 's'}`,
          `${improvements} improvement${improvements === 1 ? '' : 's'}`,
          lead.coverage?.text,
        ]
          .filter(Boolean)
          .join('  ·  ')}
        width={width}
      />
      <Decision lead={lead} />
      {lead.changes.length > 0 ? <Changes changes={lead.changes} /> : null}
      {diff.configChanges.length > 0 ? <ConfigChanges changes={diff.configChanges} /> : null}
      {lead.causes.length > 0 ? <Causes causes={lead.causes} /> : null}
      {changed.length === 0 ? (
        <Box marginTop={1}><Text color={colors.success}>✓ No route changed size, shell composition, rendering mode, or caching.</Text></Box>
      ) : (
        <>
          {chartItems.length > 0 ? (
            <Section title="SIZE MOVEMENT" hint="largest absolute changes">
              <BarChart data={chartItems} width={Math.min(width, 96)} />
            </Section>
          ) : null}
          <Section title="CHANGED ROUTES">
            <Table rows={changed} columns={columns} maxRows={60} />
          </Section>
          <DiffDetails routes={changed} explainedBytes={explained} skip={stated} />
        </>
      )}
    </Box>
  )
}

function Header({ command, id, meta, width }: { command: string; id: string; meta: string; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold color={colors.accent}>CRUST / {command.toUpperCase()}</Text>
        <Text color={colors.muted}>{id}</Text>
      </Box>
      <Text color={colors.muted}>{meta}</Text>
    </Box>
  )
}

function Findings({ findings }: { findings: Finding[] }) {
  const top = findings.slice(0, 3)
  return (
    <Section title="FIX FIRST" hint={`${findings.length} actionable finding${findings.length === 1 ? '' : 's'}`}>
      {top.map((finding, index) => (
        <Box key={`${finding.route}:${finding.headline}`} marginBottom={index < top.length - 1 ? 1 : 0}>
          <Text bold color={finding.kind === 'unknown' ? colors.warning : colors.danger}>{index + 1}. </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text><Text color={colors.accent}>{finding.route ? `${finding.route}  ` : ''}</Text>{finding.headline}</Text>
            {finding.detail ? <Text color={colors.muted}>   {finding.detail}</Text> : null}
            <Text color={colors.muted}>   → {finding.action}</Text>
          </Box>
        </Box>
      ))}
      {findings.length > top.length ? <Text color={colors.muted}>+ {findings.length - top.length} more in `crust report`</Text> : null}
    </Section>
  )
}

function RouteNotes({ routes }: { routes: RouteSnapshot[] }) {
  return (
    <Section title="ROUTE NOTES">
      {routes.map((route) => (
        <Box key={route.pattern} flexDirection="column" marginBottom={1}>
          <Text color={colors.accent}>{route.pattern}</Text>
          {route.renderingModeReason ? <Text color={colors.muted}>  ↳ {route.renderingModeReason}</Text> : null}
          {route.shell?.predictedHoles.slice(0, 3).map((hole) => (
            <Text key={`${hole.component}:${hole.reason}`} color={colors.muted}>  ✂ &lt;{hole.component}&gt; — {hole.reason}</Text>
          ))}
        </Box>
      ))}
    </Section>
  )
}

function Unknowns({ unknowns }: { unknowns: string[] }) {
  return (
    <Section title="UNKNOWN" hint="reported instead of guessed">
      {unknowns.slice(0, 5).map((unknown) => <Text key={unknown} color={colors.warning}>? {unknown}</Text>)}
      {unknowns.length > 5 ? <Text color={colors.muted}>+ {unknowns.length - 5} more in --json</Text> : null}
    </Section>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  const noMaps = warnings.filter((warning) => warning.includes('no source map emitted'))
  const rest = warnings.filter((warning) => !warning.includes('no source map emitted'))
  const missingMapChunks = new Set(noMaps.map(chunkFromSourceMapWarning)).size
  return (
    <Section title="WARNINGS" hint={`${warnings.length} total`}>
      {missingMapChunks > 0 ? (
        <Box flexDirection="column" marginBottom={rest.length > 0 ? 1 : 0}>
          <Text color={colors.warning}>! {missingMapChunks} chunk{missingMapChunks === 1 ? '' : 's'} shipped without source maps.</Text>
          <Text color={colors.muted}>  Per-file attribution is degraded; route sizes and shell analysis are unaffected.</Text>
        </Box>
      ) : null}
      {rest.slice(0, 5).map((warning) => <Text key={warning} color={colors.warning}>! {warning}</Text>)}
      {rest.length > 5 ? <Text color={colors.muted}>+ {rest.length - 5} more warnings</Text> : null}
    </Section>
  )
}

/**
 * `explainedBytes` is what the PACKAGES section above stated, per route. A route
 * it fully accounts for is left out rather than given prose that repeats it -
 * grouping only pays for itself if it *replaces* the rows it explains. The route
 * keeps its line in CHANGED ROUTES either way, so nothing disappears from the
 * inventory.
 */
function DiffDetails({
  routes,
  explainedBytes,
  skip,
}: {
  routes: RouteDelta[]
  explainedBytes: Map<string, number>
  skip: Set<string>
}) {
  const detailed = routes.filter(
    (route) =>
      (route.cause || route.modules.length > 0 || route.newHoles.length > 0) &&
      !skip.has(route.pattern) &&
      !fullyExplained(route, explainedBytes),
  )
  if (detailed.length === 0) return null
  return (
    <Section title="WHY IT MOVED">
      {detailed.map((route) => (
        <Box key={route.id} flexDirection="column" marginBottom={1}>
          <Text bold color={severityColor(route.severity)}>{route.pattern}</Text>
          {route.cause ? (
            <Text color={route.cause.kind === 'unknown' ? colors.warning : colors.foreground}>
              {'  '}cause: {route.cause.kind === 'unknown' ? 'unknown — ' : ''}{route.cause.what}
              {route.cause.component ? ` in <${route.cause.component}>` : ''}
            </Text>
          ) : null}
          {route.modules.slice(0, 5).map((module) => (
            <Text key={module.file} color={colors.muted}>  {signed(module.delta).padStart(10)}  {module.file}</Text>
          ))}
          {route.newHoles.slice(0, 3).map((hole) => (
            <Text key={`${hole.component}:${hole.reason}`} color={colors.danger}>  ✂ &lt;{hole.component}&gt; left the shell — {hole.reason}</Text>
          ))}
        </Box>
      ))}
    </Section>
  )
}

function terminalWidth(columns: number | undefined): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns ?? DEFAULT_WIDTH))
}

function shellRatio(route: RouteSnapshot): string {
  const ratio = route.shell?.actual?.shellRatio
  return ratio === undefined || ratio === null ? '—' : pct(ratio)
}

function modeText(mode: string | null): string {
  if (!mode) return '—'
  if (mode === 'PARTIALLY_STATIC') return 'partial'
  if (mode === 'ROUTE_HANDLER') return 'handler'
  return mode.toLowerCase()
}

function modeSummary(routes: RouteSnapshot[]): string {
  const counts = new Map<string, number>()
  for (const route of routes) counts.set(modeText(route.renderingMode), (counts.get(modeText(route.renderingMode)) ?? 0) + 1)
  return [...counts].map(([mode, count]) => `${count} ${mode}`).join('  ·  ')
}

function healthSummary(routes: RouteSnapshot[]): string {
  let staticRoutes = 0
  let dynamicRoutes = 0
  let handlers = 0
  let unknown = 0
  for (const route of routes) {
    if (route.renderingMode === 'ROUTE_HANDLER') handlers++
    else if (route.renderingMode === 'STATIC' || route.renderingMode === 'ISR') staticRoutes++
    else if (route.renderingMode === 'unknown') unknown++
    else dynamicRoutes++
  }
  return [
    `${staticRoutes} static`,
    `${dynamicRoutes} dynamic`,
    `${handlers} handler${handlers === 1 ? '' : 's'}`,
    ...(unknown > 0 ? [`${unknown} unknown`] : []),
  ].join(' · ')
}

function medianFirstLoad(routes: RouteSnapshot[]): number {
  const bytes = routes
    .filter((route) => route.renderingMode !== 'ROUTE_HANDLER' && route.firstLoadBytes > 0)
    .map((route) => route.firstLoadBytes)
    .sort((a, b) => a - b)
  if (bytes.length === 0) return 0
  const middle = Math.floor(bytes.length / 2)
  return bytes.length % 2 === 1 ? bytes[middle]! : Math.round((bytes[middle - 1]! + bytes[middle]!) / 2)
}

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : kb(bytes)
}

/**
 * Build IDs are opaque, so a baseline resolved from the wrong branch looks
 * exactly like the right one. Naming the branch and commit it came from makes
 * that visible in the header instead of only in `crust list`.
 */
/**
 * `<build id> (branch@sha)`. Used for both sides: with two stored refs the head
 * is no more "the current build" than the base is, and a bare pair of build ids
 * does not say which ref either one came from.
 */
function snapshotLabel(snapshot: Snapshot): string {
  const where = [snapshot.branch, snapshot.gitSha?.slice(0, 8)].filter(Boolean).join('@')
  return where ? `${snapshot.buildId} (${where}${snapshot.dirty ? '+dirty' : ''})` : snapshot.buildId
}

function shortBuild(buildId: string): string {
  return buildId.length > 12 ? buildId.slice(0, 12) : buildId
}

function regressionHeadline(route: RouteDelta): string {
  if (route.modeChange?.direction === 'regression') {
    if (route.renderingModeAfter === 'DYNAMIC') return 'became dynamic'
    return `became ${modeText(route.renderingModeAfter)}`
  }
  if (route.shellRatioBefore !== null && route.shellRatioAfter === null) return 'lost its static shell'
  if (route.shellRatioDelta !== null && route.shellRatioDelta < 0) return 'lost static shell content'
  if (route.cacheChange?.introduced.length) return 'stopped being cached'
  if (route.firstLoadDelta > 0) return `added ${kb(route.firstLoadDelta)} of first-load JavaScript`
  return 'regressed'
}

function shellMoved(route: RouteDelta): boolean {
  return route.shellRatioBefore !== route.shellRatioAfter
}

function shellNarrative(route: RouteDelta): string {
  const before = route.shellRatioBefore === null ? 'unavailable' : pct(route.shellRatioBefore)
  const after = route.shellRatioAfter === null ? 'unavailable' : pct(route.shellRatioAfter)
  return `${before} → ${after}`
}

function deltaText(route: RouteDelta): string {
  return Math.abs(route.firstLoadDelta) <= 512 ? '—' : signed(route.firstLoadDelta)
}

function shellChange(route: RouteDelta): string {
  if (route.shellRatioBefore === route.shellRatioAfter) return route.shellRatioAfter === null ? '—' : pct(route.shellRatioAfter)
  const before = route.shellRatioBefore === null ? '—' : pct(route.shellRatioBefore)
  const after = route.shellRatioAfter === null ? '—' : pct(route.shellRatioAfter)
  return `${before}→${after}`
}

function modeChange(route: RouteDelta): string {
  if (!route.modeChange) return modeText(route.renderingModeAfter)
  return `${plainModeLabel(route.modeChange.before)}→${plainModeLabel(route.modeChange.after)}`
}

function severityColor(severity: RouteDelta['severity']): string {
  if (severity === 'regression') return colors.danger
  if (severity === 'improvement') return colors.success
  return colors.warning
}

function chunkFromSourceMapWarning(warning: string): string {
  const reason = ': no source map emitted for this chunk'
  const beforeReason = warning.endsWith(reason) ? warning.slice(0, -reason.length) : warning
  const routeSeparator = beforeReason.lastIndexOf(': ')
  return routeSeparator === -1 ? beforeReason : beforeReason.slice(routeSeparator + 2)
}
