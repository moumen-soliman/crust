#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { cac } from 'cac'
import pc from 'picocolors'
import { analyzeBuild } from './analyze/analyze.ts'
import { checkBudgets, kb, readBudgets } from './ci/budgets.ts'
import { renderComment } from './ci/comment.ts'
import {
  appendFindings,
  findingsPath,
  findingsRate,
  markFinding,
  readFindings,
  recordedFromBreaches,
} from './ci/findings-log.ts'
import { buildPair, DEFAULT_BUILD_COMMAND } from './compare/build-pair.ts'
import { STORE_DIR } from './store/store.ts'
import { renderReportHtml } from './report/render.ts'
import { diffSnapshots, type RouteAliases } from './diff/diff.ts'
import { readAliases } from './diff/aliases.ts'
import { latestCompatibleBaseline } from './diff/compatible.ts'
import { findWorkspaceRoot } from './core/workspace.ts'
import { revParse } from './core/git.ts'
import { runInit, type CiChoice } from './init/init.ts'
import { renderInitTerminal } from './init/render.tsx'
import { SnapshotStore } from './store/store.ts'
import { fetchHistory, pushHistory } from './store/history-branch.ts'
import { runSynthetic } from './synthetic/run.ts'
import { renderDiffTerminal, renderSnapshotTerminal } from './terminal-ui/views.tsx'
import { VERSION } from './version.ts'
import type { Snapshot } from './store/snapshot.ts'

const cli = cac('crust')

interface CommonOptions {
  cwd: string
  distDir?: string
}

const ms = (value: number): string => `${Math.round(value)} ms`

const CI_CHOICES: CiChoice[] = ['auto', 'none', 'github', 'gitlab', 'circleci']

cli
  .command('init', 'Set up crust here: first snapshot, starter budgets, CI configuration')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--ci <provider>', `CI configuration to generate (${CI_CHOICES.join(' | ')})`, { default: 'auto' })
  .option('--force', 'Replace files init would otherwise keep')
  .option('--dry-run', 'Print the plan without writing anything')
  .action(async (options: CommonOptions & { ci: string; force?: boolean; dryRun?: boolean }) => {
    if (!CI_CHOICES.includes(options.ci as CiChoice)) {
      console.error(pc.red(`Unknown --ci value "${options.ci}". Expected one of: ${CI_CHOICES.join(', ')}.`))
      process.exitCode = 1
      return
    }

    const result = await runInit({
      cwd: options.cwd,
      ...(options.distDir ? { distDir: options.distDir } : {}),
      toolVersion: VERSION,
      ci: options.ci as CiChoice,
      force: options.force ?? false,
      dryRun: options.dryRun ?? false,
    })

    console.log(renderInitTerminal(result))
    if (!result.ok) process.exitCode = 1
  })

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
  // Two positionals, like `git diff a b`: with one, the head is the build in
  // `.next`; with two, both sides come from the store and nothing is rebuilt.
  // Comparing a release against a branch should not require checking either out.
  .command('diff [base] [head]', 'Compare two builds; the head defaults to the current one')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--build [cmd]', `Build both refs first, in temporary worktrees (default: ${DEFAULT_BUILD_COMMAND})`)
  .option('--parallel', 'With --build: build both refs at the same time')
  .option('--keep-worktrees', 'With --build: leave the worktrees on disk')
  .action(async (
    base: string | undefined,
    head: string | undefined,
    options: CommonOptions & { build?: string | boolean; parallel?: boolean; keepWorktrees?: boolean },
  ) => {
    const baseRef = base ?? 'HEAD~1'

    // With `--build` the two refs are measured first, in their own worktrees, and
    // the diff below then runs on the build ids that came back. Nothing about the
    // comparison changes: this only fills the store with the pair it needs, which
    // is otherwise two checkouts and two builds done by hand.
    let baseTarget = baseRef
    let headTarget = head
    if (options.build) {
      if (!base || !head) {
        console.error(pc.red('--build needs both refs: `crust diff <base> <head> --build`.'))
        console.error(pc.dim('  With one ref the head is the build in front of you, and there is nothing to build.'))
        process.exitCode = 1
        return
      }
      try {
        const built = await buildPair({
          cwd: options.cwd,
          baseRef: base,
          headRef: head,
          ...(typeof options.build === 'string' ? { command: options.build } : {}),
          ...(options.distDir ? { distDir: options.distDir } : {}),
          parallel: options.parallel ?? false,
          keepWorktrees: options.keepWorktrees ?? false,
          toolVersion: VERSION,
          onProgress: (line) => console.error(pc.dim(`• ${line}`)),
        })
        baseTarget = built.baseId
        headTarget = built.headId
      } catch (error) {
        console.error(pc.red(error instanceof Error ? error.message : String(error)))
        process.exitCode = 1
        return
      }
    }

    const pair = await loadPair(baseTarget, options, headTarget)

    if (!pair.head) {
      console.log(pc.yellow(`No stored snapshot found for "${head!}". Run \`crust analyze\` on that commit first.`))
      process.exitCode = 1
      return
    }
    if (!pair.base) {
      const root = await findWorkspaceRoot(resolve(options.cwd))
      const store = new SnapshotStore(root)
      const stored = await store.list()
      if (store.isSelfBaseline(baseTarget, pair.head, stored)) {
        console.log(pc.yellow(`"${baseRef}" is the same build as the head. A build cannot be compared to itself.`))
        console.log(
          pc.dim(
            '  Pass a different baseline, or `crust diff <older-id> <newer-id>` to compare two stored snapshots.',
          ),
        )
      } else {
        console.log(pc.yellow(`No stored snapshot found for "${baseRef}". Run \`crust analyze\` on that commit first.`))
      }
      process.exitCode = 1
      return
    }

    const diff = diffSnapshots(pair.base, pair.head, pair.aliases)

    // Budgets are read here so the decision this prints is the one `ci` would
    // reach on the same pair. They are the *current* file even when both sides are
    // old builds, which is the useful question ("would this pair pass today's
    // rules") and the only one a working copy can answer.
    const root = await findWorkspaceRoot(resolve(options.cwd))
    const breaches = checkBudgets(pair.head, await readBudgets(root), diff)

    console.log(renderDiffTerminal(diff, { breaches }))
  })

cli
  .command('ci [ref]', 'Check budgets and print a PR comment; exits non-zero on breach')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--dist-dir <dir>', 'Build output directory', { default: '.next' })
  .option('--comment <file>', 'Write the PR comment markdown to a file')
  .action(async (ref: string | undefined, options: CommonOptions & { comment?: string }) => {
    // `main` names the branch of the project being analysed, not crust's own
    // (crust develops on master). It is the ecosystem default for new repos, and
    // SnapshotStore.resolve merge-bases `main` and `master` alike, so a `master`
    // project only has to pass the ref explicitly to get the same behaviour.
    const { head, base, aliases } = await loadPair(ref ?? 'main', options)
    const diff = base ? diffSnapshots(base, head, aliases) : null

    const root = await findWorkspaceRoot(resolve(options.cwd))
    const store = new SnapshotStore(root)
    const budgets = await readBudgets(root)
    const breaches = checkBudgets(head, budgets, diff)
    await store.write(head)

    const comment = renderComment(head, diff, breaches)
    if (options.comment) await writeFile(options.comment, comment + '\n', 'utf8')
    else console.log(comment)

    // Every blocking breach is a measurement opportunity. Appended here so the
    // disagreement rate Focus 3 needs can be collected from a live PR stream;
    // the rate itself is never invented from an empty log.
    if (breaches.length > 0) {
      const recorded = recordedFromBreaches(breaches, head, base)
      await appendFindings(join(root, STORE_DIR), recorded)
      console.error(
        pc.dim(
          `\nRecorded ${recorded.length} blocking finding${recorded.length === 1 ? '' : 's'} → ${relative(process.cwd(), findingsPath(join(root, STORE_DIR)))}`,
        ),
      )
      console.error(pc.dim('  Mark each with `crust findings agree <id>` or `crust findings dispute <id>`.'))
    }

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
  // Same positional shape as `history`: `findings rate`, not a nested command.
  .command('findings <action> [id]', 'Record and score blocking-finding agreement (list | agree | dispute | rate)')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .option('--note <text>', 'Why this finding was agreed or disputed')
  .option('--open', 'With list: only unfinished rows')
  .action(async (
    action: string,
    id: string | undefined,
    options: CommonOptions & { note?: string; open?: boolean },
  ) => {
    const root = await findWorkspaceRoot(resolve(options.cwd))
    const perfDir = join(root, STORE_DIR)

    if (action === 'list') {
      const rows = await readFindings(perfDir)
      const shown = options.open ? rows.filter((row) => row.verdict === 'open') : rows
      if (shown.length === 0) {
        console.log(pc.dim(options.open ? 'No open findings.' : 'No findings recorded yet. Blocking `ci` runs append here.'))
        return
      }
      for (const row of shown) {
        const mark =
          row.verdict === 'open' ? pc.yellow('open') : row.verdict === 'agreed' ? pc.green('agreed') : pc.red('disputed')
        console.log(`${pc.bold(row.id)}  ${mark}  ${pc.cyan(row.kind)}  ${row.pattern}  ${pc.dim(row.message)}`)
        if (row.blame) console.log(pc.dim(`  blame ${row.blame}`))
        if (row.note) console.log(pc.dim(`  note  ${row.note}`))
      }
      return
    }

    if (action === 'rate') {
      const rate = findingsRate(await readFindings(perfDir))
      console.log(`${pc.bold('crust findings')}  ${pc.dim(relative(process.cwd(), findingsPath(perfDir)) || findingsPath(perfDir))}`)
      console.log(`  open      ${rate.open}`)
      console.log(`  agreed    ${rate.agreed}`)
      console.log(`  disputed  ${rate.disputed}`)
      console.log(`  resolved  ${rate.resolved}`)
      if (rate.disagreementRate === null) {
        console.log(pc.dim('\nNo marked findings yet — disagreement rate is unmeasured, not 0%.'))
        console.log(pc.dim('Target: fewer than 1 in 10 resolved findings disputed.'))
      } else {
        const pct = `${(rate.disagreementRate * 100).toFixed(1)}%`
        const ok = rate.disagreementRate < 0.1
        console.log(`\n  disagreement  ${ok ? pc.green(pct) : pc.red(pct)}  ${pc.dim('(target < 10%)')}`)
      }
      return
    }

    if (action === 'agree' || action === 'dispute') {
      if (!id) {
        console.error(pc.red(`Usage: crust findings ${action} <id> [--note "..."]`))
        process.exitCode = 1
        return
      }
      try {
        const updated = await markFinding(perfDir, id, action === 'agree' ? 'agreed' : 'disputed', options.note ?? null)
        console.log(
          `${pc.green('✓')} ${updated.id}  ${action === 'agree' ? pc.green('agreed') : pc.red('disputed')}  ${updated.pattern}`,
        )
      } catch (error) {
        console.error(pc.red(error instanceof Error ? error.message : String(error)))
        process.exitCode = 1
      }
      return
    }

    console.error(pc.red(`Unknown findings action "${action}". Expected list, agree, dispute, or rate.`))
    process.exitCode = 1
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

cli
  // A subcommand rather than a subpath export: `exports` in package.json is
  // public API under COMPATIBILITY.md, and the tool surface is still settling.
  .command('mcp', 'Serve this project\'s snapshots to an MCP-capable agent over stdio')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .action(async (options: CommonOptions) => {
    // Nothing is printed to stdout here on purpose - see `protectStdout`.
    const { serveMcp } = await import('./mcp/server.ts')
    await serveMcp({ cwd: options.cwd, version: VERSION })
  })

cli
  /**
   * The same tools `crust mcp` serves, run once against this project and printed.
   *
   * Without this, seeing a single answer costs a build, an MCP client, a
   * registration and a session restart - and if the answer is wrong, none of
   * those steps tells you which one failed. The tools are plain functions over
   * `.perf/`, so the honest way to try them is to call one.
   */
  .command('ask [tool] [...pairs]', 'Run one MCP tool here and print its answer (key=value arguments)')
  .option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  .example('  crust ask')
  .example('  crust ask build_findings')
  .example('  crust ask route_detail route=/dashboard')
  .example('  crust ask compare_builds base=<buildId> head=<buildId>')
  .action(async (tool: string | undefined, pairs: string[], options: CommonOptions) => {
    const { openSession } = await import('./mcp/answers.ts')
    const { callTool, TOOLS } = await import('./mcp/tools.ts')

    if (!tool) {
      console.log(pc.bold('crust ask <tool> [key=value ...]'))
      console.log(pc.dim('The same read-only tools `crust mcp` serves an agent. Nothing here builds.\n'))
      for (const spec of TOOLS) {
        const args = Object.keys(spec.inputSchema.properties)
        const required = new Set(spec.inputSchema.required ?? [])
        const signature = args.map((arg) => (required.has(arg) ? `${arg}=` : pc.dim(`[${arg}=]`))).join(' ')
        console.log(`  ${pc.bold(spec.name.padEnd(20))} ${signature}`)
        console.log(`  ${' '.repeat(20)} ${pc.dim(spec.title)}`)
      }
      console.log(pc.dim('\ne.g. crust ask route_detail route=/dashboard'))
      return
    }

    // `key=value`, not `--key value`: these are tool arguments rather than crust
    // flags, and keeping them out of the flag namespace means a tool can grow an
    // argument without colliding with `--cwd` or a future crust option.
    const input: Record<string, unknown> = {}
    for (const pair of pairs) {
      const at = pair.indexOf('=')
      if (at === -1) {
        console.error(pc.red(`"${pair}" is not a key=value pair.`))
        console.error(pc.dim('  e.g. crust ask route_detail route=/dashboard'))
        process.exitCode = 1
        return
      }
      const key = pair.slice(0, at)
      const value = pair.slice(at + 1)
      input[key] = /^\d+$/.test(value) ? Number(value) : value
    }

    const answer = await callTool(await openSession(options.cwd), tool, input)
    console.log(JSON.stringify(answer, null, 2))
    if ((answer as { ok?: unknown }).ok === false) process.exitCode = 1
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

// Overloaded so the callers that never name a head - `ci`, which must measure
// the build in front of it - keep a non-null `head` without asserting.
async function loadPair(
  ref: string,
  options: CommonOptions,
): Promise<{ head: Snapshot; base: Snapshot | null; aliases: RouteAliases }>
async function loadPair(
  ref: string,
  options: CommonOptions,
  headRef: string | undefined,
): Promise<{ head: Snapshot | null; base: Snapshot | null; aliases: RouteAliases }>
async function loadPair(
  ref: string,
  options: CommonOptions,
  headRef?: string,
): Promise<{ head: Snapshot | null; base: Snapshot | null; aliases: RouteAliases }> {
  const root = await findWorkspaceRoot(resolve(options.cwd))
  const store = new SnapshotStore(root)
  const aliases = await readAliases(root)

  // A named head is read from the store; only the implicit head is analysed.
  // Rebuilding a commit in order to compare it is the cost this avoids.
  //
  // Both refs then resolve from themselves. Two names mean two builds, and the
  // branch that happens to be checked out is not one of them: anchoring either
  // side on a merge base with HEAD answers with the commit this working copy
  // shares with the ref, which is a third build nobody asked about.
  const exact = headRef !== undefined
  const head = headRef
    ? await store.resolve(headRef, options.cwd, undefined, { exact })
    : await analyzeBuild({
        cwd: options.cwd,
        ...(options.distDir ? { distDir: options.distDir } : {}),
        toolVersion: VERSION,
      })
  if (!head) return { head: null, base: null, aliases }

  // `head` is passed so that a commit holding several snapshots yields one this
  // build can be compared against, rather than whichever was written first.
  let base = await store.resolve(ref, options.cwd, head, { exact })

  // Squash merges orphan snapshots - the pre-squash SHAs stop existing, so
  // ancestry lookup finds nothing. Fall back to matching by analysed content
  // (R13), but only for a ref git recognises. Re-linking by content behind a ref
  // that does not exist answers a question about a branch nobody has with a
  // snapshot of the current source, which reports "no regressions" for the one
  // reason a reviewer would never suspect.
  //
  // Not for an explicitly named head either. The fallback matches on the head's
  // source, so behind two named refs it can answer "what is `release`" with a
  // snapshot recorded on neither ref - the same substitution, one step further
  // from the question.
  if (!base && !headRef && (await revParse(options.cwd, ref))) {
    base = await store.findBySourceSignature(head.sourceSignature, head.buildId)
  }

  return { head, base, aliases }
}

cli.help()
cli.version(VERSION)
cli.parse()
