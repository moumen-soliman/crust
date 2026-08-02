#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { cac } from 'cac'
import pc from 'picocolors'
import { analyzeBuild } from './analyze/analyze.ts'
import { checkBudgets, kb, readBudgets } from './ci/budgets.ts'
import { renderComment } from './ci/comment.ts'
import { renderReportHtml } from './report/render.ts'
import { diffSnapshots, type RouteAliases } from './diff/diff.ts'
import { latestCompatibleBaseline } from './diff/compatible.ts'
import { findWorkspaceRoot } from './core/workspace.ts'
import { SnapshotStore } from './store/store.ts'
import { fetchHistory, pushHistory } from './store/history-branch.ts'
import { runSynthetic } from './synthetic/run.ts'
import { renderDiffTerminal, renderSnapshotTerminal } from './terminal-ui/views.tsx'
import type { Snapshot } from './store/snapshot.ts'

const VERSION = '0.1.2'
const cli = cac('crust')

interface CommonOptions {
  cwd: string
  distDir?: string
}

const ms = (value: number): string => `${Math.round(value)} ms`

cli
  .command('analyze', 'Analyse a production build and record a snapshot')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--json [file]', 'Write the snapshot as JSON instead of a table')
  .option('--routes', 'Include the complete route table')
  .option('--verbose', 'Include routes, shell notes, unknowns, and warnings')
  .option('--report [file]', 'Also write an HTML report', { default: false })
  .option('--no-save', 'Do not write a snapshot into .perf/')
  .action(async (options: CommonOptions & {
    json?: string | boolean
    routes?: boolean
    verbose?: boolean
    report?: string | boolean
    save?: boolean
  }) => {
    const snapshot = await analyzeBuild({
      cwd: options.cwd,
      ...(options.distDir ? { distDir: options.distDir } : {}),
      toolVersion: VERSION,
    })

    const root = await findWorkspaceRoot(resolve(options.cwd))
    const store = new SnapshotStore(root)
    const [stored, budgets, aliases] = await Promise.all([
      store.list(),
      readBudgets(root),
      readAliases(root),
    ])
    const base = latestCompatibleBaseline(snapshot, stored)
    const diff = base ? diffSnapshots(base, snapshot, aliases) : null
    const breaches = checkBudgets(snapshot, budgets, diff)

    let snapshotPath: string | null = null
    if (options.save !== false) snapshotPath = await store.write(snapshot)

    let reportPath: string | null = null
    if (options.report) {
      const out = resolve(typeof options.report === 'string' ? options.report : 'crust-report.html')
      await writeFile(out, renderReportHtml(await withHistory(snapshot, options.cwd)), 'utf8')
      reportPath = relative(process.cwd(), out) || out
    }

    if (options.json) {
      const json = JSON.stringify(snapshot, null, 2)
      if (typeof options.json === 'string') await writeFile(options.json, json + '\n', 'utf8')
      else console.log(json)
    } else {
      console.log(renderSnapshotTerminal(snapshot, {
        diff,
        breaches,
        showRoutes: options.routes ?? false,
        verbose: options.verbose ?? false,
        reportPath,
      }))
    }

    if (snapshotPath && !options.json) console.log(pc.dim(`\nsnapshot -> ${relative(process.cwd(), snapshotPath)}`))
  })

cli
  .command('diff [ref]', 'Compare this build against a stored snapshot')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .action(async (ref: string | undefined, options: CommonOptions) => {
    const { head, base, aliases } = await loadPair(ref ?? 'HEAD~1', options)
    if (!base) {
      console.log(pc.yellow(`No stored snapshot found for "${ref ?? 'HEAD~1'}". Run \`crust analyze\` on that commit first.`))
      process.exitCode = 1
      return
    }

    const diff = diffSnapshots(base, head, aliases)
    console.log(renderDiffTerminal(diff))
  })

cli
  .command('ci [ref]', 'Check budgets and print a PR comment; exits non-zero on breach')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--comment <file>', 'Write the PR comment markdown to a file')
  .action(async (ref: string | undefined, options: CommonOptions & { comment?: string }) => {
    const { head, base, aliases } = await loadPair(ref ?? 'main', options)
    const diff = base ? diffSnapshots(base, head, aliases) : null

    const root = await findWorkspaceRoot(resolve(options.cwd))
    const budgets = await readBudgets(root)
    const breaches = checkBudgets(head, budgets, diff)

    const comment = renderComment(head, diff, breaches)
    if (options.comment) await writeFile(options.comment, comment + '\n', 'utf8')
    else console.log(comment)

    if (!base) {
      console.error(
        pc.yellow(`\nNo baseline snapshot for "${ref ?? 'main'}" - regressions cannot be detected on this run.`),
      )
      console.error(pc.dim('  Run `crust history fetch`, or `crust analyze` on the base branch.'))
    } else if (!budgets) {
      // Regression rules need no thresholds and already ran; only the ceilings are
      // missing. Saying "nothing was enforced" here would be false.
      console.error(pc.dim('\nNo .perf/budgets.json - size and shell ceilings are unset; regression checks still ran.'))
    }
    if (breaches.length > 0) process.exitCode = 1
  })

cli
  .command('report', 'Write a self-contained HTML report you can open in a browser')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--out <file>', 'Output path', { default: 'crust-report.html' })
  .option('--open', 'Open the report when it is written')
  .action(async (options: CommonOptions & { out: string; open?: boolean }) => {
    const snapshot = await analyzeBuild({
      cwd: options.cwd,
      ...(options.distDir ? { distDir: options.distDir } : {}),
      toolVersion: VERSION,
    })

    const enriched = await withHistory(snapshot, options.cwd)
    const out = resolve(options.out)
    await writeFile(out, renderReportHtml(enriched), 'utf8')
    console.log(`${pc.green('✓')} ${relative(process.cwd(), out)}  ${pc.dim(`${snapshot.routes.length} routes`)}`)

    if (options.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(opener, [out], { stdio: 'ignore', detached: true }).unref()
    }
  })

cli
  .command('manifest', 'Write the snapshot where the in-app widget can fetch it')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--out <file>', 'Output path, inside a publicly served directory', {
    default: 'public/crust-manifest.json',
  })
  .action(async (options: CommonOptions & { out: string }) => {
    const snapshot = await analyzeBuild({
      cwd: options.cwd,
      ...(options.distDir ? { distDir: options.distDir } : {}),
      toolVersion: VERSION,
    })

    const enriched = await withHistory(snapshot, options.cwd)
    const out = resolve(options.cwd, options.out)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, JSON.stringify(enriched), 'utf8')
    console.log(`${pc.green('✓')} ${relative(process.cwd(), out)}`)
    console.log(
      pc.yellow('  This file lists every route, source path and component name in the app.'),
    )
    console.log(pc.dim('  Do not ship it to production - generate it only in analyze builds (R8).'))
  })

cli
  // cac matches a command on its first token only, so `history push` as a command
  // name is never reachable - it silently falls through and does nothing. The
  // action has to be a positional argument.
  .command('history <action>', 'Sync .perf snapshots with the perf-history branch (push | fetch)')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--remote <name>', 'Git remote', { default: 'origin' })
  .action(async (action: string, options: CommonOptions & { remote: string }) => {
    if (action !== 'push' && action !== 'fetch') {
      console.error(pc.red(`Unknown history action "${action}". Expected push or fetch.`))
      process.exitCode = 1
      return
    }
    const root = await findWorkspaceRoot(resolve(options.cwd))
    const sync = action === 'push' ? pushHistory : fetchHistory
    const result = await sync(root, { remote: options.remote })
    console.log(`${result.pushed ? pc.green('✓') : pc.yellow('•')} ${result.detail}`)
  })

cli
  .command('prune', 'Apply the retention ladder to stored snapshots')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dry-run', 'Report what would be removed without removing it')
  .action(async (options: CommonOptions & { dryRun?: boolean }) => {
    const store = new SnapshotStore(await findWorkspaceRoot(resolve(options.cwd)))
    const result = await store.prune({ dryRun: options.dryRun ?? false })
    console.log(
      `${pc.green('✓')} kept ${result.kept} full, thinned ${result.thinned}, dropped ${result.dropped}${options.dryRun ? pc.dim('  (dry run)') : ''}`,
    )
  })

cli
  .command('synthetic <baseUrl> [...routes]', 'Measure routes against a running deployment (needs Playwright)')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--iterations <n>', 'Iterations per route; the first is discarded', { default: 5 })
  .option('--cpu <rate>', 'CPU throttle multiplier', { default: 4 })
  .option('--network <profile>', 'fast-3g | slow-3g | none', { default: 'fast-3g' })
  .action(async (baseUrl: string, routes: string[], options: CommonOptions & { iterations: number; cpu: number; network: 'fast-3g' | 'slow-3g' | 'none' }) => {
    if (routes.length === 0) routes = ['/']
    const root = await findWorkspaceRoot(resolve(options.cwd))
    const { runId, results, outPath } = await runSynthetic({
      baseUrl,
      routes,
      iterations: Number(options.iterations),
      cpuThrottle: Number(options.cpu),
      network: options.network,
      outDir: join(root, '.perf'),
    })
    console.log(`${pc.bold('crust synthetic')} ${runId}  ${pc.dim(`${options.cpu}x cpu · ${options.network} · median of ${Number(options.iterations) - 1}`)}`)
    console.log(pc.dim('vs. previous build on the same fingerprint - never "is this fast" (R9)'))
    console.log()
    for (const r of results) {
      console.log(`${r.route.padEnd(28)} ttfb ${ms(r.median.ttfb)}  fcp ${ms(r.median.fcp)}  lcp ${ms(r.median.lcp)}  ${kb(r.median.transferBytes)}`)
    }
    console.log(pc.dim(`\nrun -> ${relative(process.cwd(), outPath)}`))
  })

cli
  .command('list', 'List stored snapshots')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .action(async (options: CommonOptions) => {
    const store = new SnapshotStore(await findWorkspaceRoot(resolve(options.cwd)))
    const all = await store.list()
    if (all.length === 0) {
      console.log(pc.dim('No snapshots yet. Run `crust analyze`.'))
      return
    }
    for (const s of all) {
      const sha = s.gitSha ? s.gitSha.slice(0, 8) : pc.dim('no-git')
      console.log(
        `${pc.bold(s.buildId)}  ${sha}${s.dirty ? pc.yellow('+dirty') : '      '}  ${pc.dim(s.branch ?? '-')}  ${s.routes.length} routes  ${pc.dim(s.committedAt ?? s.createdAt)}`,
      )
    }
  })

async function withHistory(snapshot: Snapshot, cwd: string): Promise<Snapshot> {
  const store = new SnapshotStore(await findWorkspaceRoot(resolve(cwd)))
  const trends = await store.routeHistory(30, snapshot)
  if (trends.size === 0) return snapshot
  const history: NonNullable<Snapshot['history']> = {}
  for (const [routeId, points] of trends) {
    history[routeId] = { bytes: points.map((p) => p.bytes), shell: points.map((p) => p.shellRatio) }
  }
  return { ...snapshot, history }
}

async function loadPair(ref: string, options: CommonOptions): Promise<{ head: Snapshot; base: Snapshot | null; aliases: RouteAliases }> {
  const head = await analyzeBuild({
    cwd: options.cwd,
    ...(options.distDir ? { distDir: options.distDir } : {}),
    toolVersion: VERSION,
  })
  const root = await findWorkspaceRoot(resolve(options.cwd))
  const store = new SnapshotStore(root)
  let base = await store.resolve(ref, options.cwd)

  // Squash merges orphan snapshots - the pre-squash SHAs stop existing, so
  // ancestry lookup finds nothing. Fall back to matching by analysed content (R13).
  base ??= await store.findBySourceSignature(head.sourceSignature, head.buildId)

  return { head, base, aliases: await readAliases(root) }
}

async function readAliases(root: string): Promise<RouteAliases> {
  try {
    return JSON.parse(await readFile(join(root, '.perf', 'aliases.json'), 'utf8')) as RouteAliases
  } catch {
    return {}
  }
}

cli.help()
cli.version(VERSION)
cli.parse()
