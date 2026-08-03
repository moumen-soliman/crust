import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { analyzeBuild } from '../analyze/analyze.ts'
import { pct } from '../ci/budgets.ts'
import { latestCompatibleBaseline } from '../diff/compatible.ts'
import { exists, readText } from '../core/fs.ts'
import { findWorkspaceRoot, relativePosix } from '../core/workspace.ts'
import { SnapshotStore } from '../store/store.ts'
import type { Snapshot } from '../store/snapshot.ts'
import { ZERO_CONFIG_RULES, deriveStarterBudgets } from './budgets.ts'
import { ciConfigFor } from './ci.ts'
import {
  chooseNextApp,
  detectBaseline,
  detectCiProvider,
  detectNodeMajor,
  detectPackageManager,
  type CiProvider,
  type NextApp,
} from './detect.ts'

export type CiChoice = CiProvider | 'auto' | 'none'

export interface InitOptions {
  cwd: string
  distDir?: string
  toolVersion: string
  /** `auto` detects the provider; `none` writes no CI config. */
  ci?: CiChoice
  /** Replace files init would otherwise keep. */
  force?: boolean
  /** Report the plan and write nothing. */
  dryRun?: boolean
}

export interface InitStep {
  title: string
  status: 'ok' | 'warn' | 'skip' | 'fail'
  /** One line, printed beside the title. */
  detail: string
  /** Explanation under it. */
  lines: string[]
}

export interface InitFile {
  /** Workspace-relative. */
  path: string
  status: 'written' | 'kept' | 'planned'
  detail: string | null
}

export interface InitResult {
  ok: boolean
  root: string
  app: NextApp | null
  snapshot: Snapshot | null
  baseline: string
  steps: InitStep[]
  files: InitFile[]
  /** Printed last. Empty when init stopped early - there is no next step but the fix. */
  nextSteps: string[]
  dryRun: boolean
}

/**
 * Guided setup: one command from an installed package to a check that fails on a
 * real regression.
 *
 * Every step reports what it found and what it decided, because the decisions are
 * the point - a setup command that silently picks an app, a baseline branch and a
 * set of thresholds has produced a check nobody can defend in review. Nothing
 * existing is overwritten without `--force`, and `--dry-run` prints the same
 * report while writing nothing.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const cwd = resolve(options.cwd)
  const distDir = options.distDir ?? '.next'
  const dryRun = options.dryRun ?? false
  const root = await findWorkspaceRoot(cwd)
  const steps: InitStep[] = []
  const files: InitFile[] = []
  // Carries the app it got as far as identifying: the header names it, and
  // "which app did it even look at" is the first question a failed setup raises.
  const stop = (identified: NextApp | null = null): InitResult => ({
    ok: false,
    root,
    app: identified,
    snapshot: null,
    baseline: 'main',
    steps,
    files,
    nextSteps: [],
    dryRun,
  })

  // 1. The app
  if (!(await exists(cwd))) {
    // Without this, a typo in --cwd falls through to the workspace scan and the
    // report names some other app entirely - answering a question nobody asked.
    steps.push({
      title: 'Next.js app',
      status: 'fail',
      detail: `${options.cwd} does not exist`,
      lines: ['Point --cwd at the directory holding the Next.js app.'],
    })
    return stop()
  }

  const choice = await chooseNextApp(root, cwd)
  if (!choice.app) {
    steps.push({
      title: 'Next.js app',
      status: 'fail',
      detail: choice.how === 'ambiguous' ? `${choice.candidates.length} apps found - name one` : 'none found',
      lines:
        choice.how === 'ambiguous'
          ? [
              'Several Next.js apps live in this workspace, and analysing the wrong one silently',
              'is worse than asking. Rerun from the app directory or name it:',
              ...choice.candidates.map((app) => `  crust init --cwd ${app.relativeDir}`),
            ]
          : [
              `No package depending on next and no next.config.* under ${describe(root, cwd)}.`,
              'crust analyses Next.js App Router builds; point --cwd at the app if it lives elsewhere.',
            ],
    })
    return stop()
  }
  const app = choice.app
  steps.push({
    title: 'Next.js app',
    status: 'ok',
    detail: `${app.relativeDir}${app.packageName ? `  (${app.packageName})` : ''}`,
    lines: [chosenBecause(choice.how, choice.candidates.length)],
  })

  const [packageManager, nodeChoice, baselineChoice] = await Promise.all([
    detectPackageManager(root),
    detectNodeMajor(root, app.dir),
    detectBaseline(root),
  ])
  const baseline = baselineChoice.branch

  // 2. The build
  const buildDir = join(app.dir, distDir)
  if (!(await exists(join(buildDir, 'app-path-routes-manifest.json')))) {
    steps.push({
      title: 'Production build',
      status: 'fail',
      detail: `nothing analysable at ${app.relativeDir === '.' ? distDir : `${app.relativeDir}/${distDir}`}`,
      lines: [
        `Run the production build first, then rerun crust init:`,
        `  ${app.relativeDir === '.' ? '' : `cd ${app.relativeDir} && `}${buildCommandFor(packageManager.name, app)}`,
        'Development output is not valid evidence, so crust measures production builds only.',
        `If Next.js writes somewhere other than ${distDir}, pass --dist-dir <directory>.`,
      ],
    })
    return stop(app)
  }

  // 3. First snapshot
  const store = new SnapshotStore(root)
  let snapshot: Snapshot
  let existing: Snapshot[]
  try {
    ;[snapshot, existing] = await Promise.all([
      analyzeBuild({ cwd: app.dir, distDir, toolVersion: options.toolVersion }),
      store.list(),
    ])
  } catch (error) {
    steps.push({
      title: 'Production build',
      status: 'fail',
      detail: 'found, but not analysable',
      lines: String(error instanceof Error ? error.message : error).split('\n'),
    })
    return stop(app)
  }

  steps.push({
    title: 'Production build',
    status: 'ok',
    detail: `${app.relativeDir === '.' ? distDir : `${app.relativeDir}/${distDir}`}  ·  Next ${snapshot.nextVersion} · ${snapshot.bundler}`,
    lines: [
      `Cache Components ${snapshot.config?.cacheComponents ? 'on' : 'off'} · Node ${nodeChoice.major} in CI (from ${nodeChoice.how}) · baseline ${baseline} (${baselineChoice.how})`,
      ...snapshot.warnings.map((warning) => warning),
    ],
  })

  const snapshotPath = dryRun ? null : await store.write(snapshot)
  if (snapshotPath) {
    files.push({ path: relativePosix(root, snapshotPath), status: 'written', detail: 'snapshot' })
  }
  steps.push(snapshotStep(snapshot, existing))

  // 4. Source-map attribution
  steps.push(attributionStep(snapshot))

  // 5. Starter budgets
  const starter = deriveStarterBudgets(snapshot)
  if (!starter) {
    steps.push({
      title: 'Starter budgets',
      status: 'skip',
      detail: 'no sized routes to derive from',
      lines: ['Regression rules still apply - they need no thresholds. See below.'],
    })
  } else {
    const written = await writeIfAbsent(
      root,
      '.perf/budgets.json',
      JSON.stringify(starter.budgets, null, 2) + '\n',
      { force: options.force ?? false, dryRun },
    )
    files.push(written)
    steps.push({
      title: 'Starter budgets',
      status: written.status === 'kept' ? 'skip' : 'ok',
      detail: written.status === 'kept' ? '.perf/budgets.json kept as it is' : '.perf/budgets.json',
      lines:
        written.status === 'kept'
          ? ['A budget file already exists, so nothing was changed. Rerun with --force to replace it.']
          : [...starter.notes, ...(await gitignoreAdvice(root))],
    })
  }

  // 6. CI configuration
  const ciChoice = options.ci ?? 'auto'
  if (ciChoice === 'none') {
    steps.push({
      title: 'CI configuration',
      status: 'skip',
      detail: 'skipped (--ci none)',
      lines: ['crust ci runs the same check locally; see the commands below.'],
    })
  } else {
    const detection = ciChoice === 'auto' ? await detectCiProvider(root) : { provider: ciChoice, how: '--ci' }
    if (!detection.provider) {
      steps.push({
        title: 'CI configuration',
        status: 'warn',
        detail: `no provider detected (${detection.how})`,
        lines: ['Name one to generate its config: crust init --ci github | gitlab | circleci'],
      })
    } else {
      const config = ciConfigFor({
        provider: detection.provider,
        toolVersion: options.toolVersion,
        packageManager: packageManager.name,
        packageManagerVersion: packageManager.declaredVersion,
        app,
        distDir,
        baseline,
        nodeMajor: nodeChoice.major,
      })
      const written = await writeIfAbsent(root, config.path, config.contents, {
        force: options.force ?? false,
        dryRun,
      })
      files.push(written)
      steps.push({
        title: 'CI configuration',
        status: written.status === 'kept' ? 'skip' : 'ok',
        detail: `${config.path}${written.status === 'kept' ? '  kept as it is' : ''}`,
        lines: [
          `${detection.provider} detected: ${detection.how}.`,
          ...(written.status === 'kept'
            ? ['That file already exists, so nothing was changed. Rerun with --force to replace it.']
            : [
                `Pinned to @moumensoliman/crust@${options.toolVersion}, so a crust release cannot change the verdict without a commit.`,
                `Builds with ${packageManager.name}${packageManager.declaredVersion ? ` ${packageManager.declaredVersion}` : ''}, compares against ${baseline}, and posts one comment it updates in place.`,
                ...(config.kind === 'snippet'
                  ? [`${detection.provider} keeps its whole pipeline in one file, so this is a job to paste in rather than a file that runs.`]
                  : []),
              ]),
        ],
      })
    }
  }

  // 7. What fails with no thresholds at all
  steps.push({
    title: 'Enforced with no config',
    status: 'ok',
    detail: '3 regression rules, live as soon as a baseline exists',
    lines: [
      ...ZERO_CONFIG_RULES.map((rule) => `- ${rule}`),
      'Each is a downgrade against your own previous build, so it needs no number to be true.',
      'Budgets only add ceilings, and no delta rule fires when the two builds are incomparable.',
    ],
  })

  return {
    ok: true,
    root,
    app,
    snapshot,
    baseline,
    steps,
    files,
    nextSteps: nextStepsFor({ app, baseline, files, dryRun }),
    dryRun,
  }
}

function nextStepsFor(input: { app: NextApp; baseline: string; files: InitFile[]; dryRun: boolean }): string[] {
  const cwdFlag = input.app.relativeDir === '.' ? '' : ` --cwd ${input.app.relativeDir}`
  if (input.dryRun) return ['Nothing was written. Rerun without --dry-run to apply this plan.']

  const committable = input.files.filter((file) => file.status === 'written' && !file.path.startsWith('.perf/builds'))
  return [
    ...(committable.length > 0 ? [`Commit ${committable.map((file) => file.path).join(' and ')}.`] : []),
    `Record the baseline: run the check once on ${input.baseline} so pull requests have something to compare against.`,
    `See it fail on purpose: add \`export const dynamic = 'force-dynamic'\` to a static page, rebuild, then \`crust ci ${input.baseline}${cwdFlag}\` - it exits 1 and names the mode drop.`,
    `Explore this build: \`crust report --open${cwdFlag}\`.`,
  ]
}

/**
 * `.perf/` holds two unlike things: generated snapshots, which travel on the
 * orphan history branch, and the budget file, which is a decision the project
 * made and belongs in review. An ignore rule that does not separate them either
 * commits every build or hides the thresholds.
 */
async function gitignoreAdvice(root: string): Promise<string[]> {
  const contents = (await readText(join(root, '.gitignore'))) ?? ''
  const lines = contents.split('\n').map((line) => line.trim())
  if (lines.some((line) => line === '!.perf/budgets.json')) return []

  const ignoresPerf = lines.some((line) => line === '.perf' || line === '.perf/' || line === '.perf/*')
  return [
    ignoresPerf
      ? 'Your .gitignore hides all of .perf/, including this file. Keep the snapshots ignored and the budgets reviewable:'
      : 'Snapshots in .perf/ are generated and travel on the perf-history branch; the budget file is not. Suggested .gitignore:',
    '  .perf/*',
    '  !.perf/budgets.json',
  ]
}

async function writeIfAbsent(
  root: string,
  relativePath: string,
  contents: string,
  options: { force: boolean; dryRun: boolean },
): Promise<InitFile> {
  const target = join(root, relativePath)
  const present = await exists(target)
  if (present && !options.force) {
    return { path: relativePath, status: 'kept', detail: 'already exists' }
  }
  if (options.dryRun) {
    return { path: relativePath, status: 'planned', detail: present ? 'would be replaced' : 'would be created' }
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
  return { path: relativePath, status: 'written', detail: present ? 'replaced' : null }
}

/**
 * Stored snapshots are not the same thing as a usable baseline: ones from an older
 * schema, another bundler or a different Next major are refused by the comparison.
 * Counting them would report a project as ready while its first CI run says
 * "nothing to compare".
 */
function snapshotStep(snapshot: Snapshot, existing: Snapshot[]): InitStep {
  const baseline = latestCompatibleBaseline(snapshot, existing)
  const { coverage } = snapshot

  const state = baseline
    ? [`Comparable baseline found (${baseline.buildId}), so regression rules are live from this build on.`]
    : existing.length === 0
      ? ['This build is the baseline. Regression checks compare against it from the next build onwards.']
      : [
          `${existing.length} snapshot${existing.length === 1 ? '' : 's'} in .perf/, and none is comparable to this build - ${incomparableReason(snapshot, existing)}.`,
          'No regression check can run against them. This build becomes the baseline instead, so the rules go live one build later.',
        ]

  return {
    title: 'First snapshot',
    status: existing.length > 0 && !baseline ? 'warn' : 'ok',
    detail: `${snapshot.buildId}  ${snapshot.routes.length} routes · confidence ${pct(coverage.confidence)}`,
    lines: [
      ...state,
      `${coverage.routesClassified}/${coverage.routesTotal} routes classified · ${coverage.shellsMeasured}/${coverage.shellsEmitted} emitted shells measured`,
    ],
  }
}

function attributionStep(snapshot: Snapshot): InitStep {
  const { clientBytesAttributed, clientBytesTotal } = snapshot.coverage

  if (!snapshot.config?.sourceMaps) {
    return {
      title: 'Source attribution',
      status: 'warn',
      detail: 'off - per-file blame unavailable',
      lines: [
        'Route totals, rendering modes, dynamic-route causes and shell composition are all',
        'measured without maps; only "which file are these bytes" is missing, and crust says',
        'so rather than guessing. Turn it on with:',
        '  // next.config.ts',
        '  export default { productionBrowserSourceMaps: true }',
        'Enable it in a dedicated analyze build if you would rather not ship maps.',
      ],
    }
  }

  const share = clientBytesTotal > 0 ? clientBytesAttributed / clientBytesTotal : 0
  return {
    title: 'Source attribution',
    status: 'ok',
    detail: `on - ${pct(share)} of client bytes traced to a file`,
    lines: ['Cause chains can name the source line responsible, not just the route.'],
  }
}

/**
 * Why the stored snapshots cannot serve as a baseline, in the terms the diff uses
 * to refuse them. Named rather than summarised as "incompatible": the schema case
 * is fixed by re-analysing, the bundler and framework cases are waited out.
 */
export function incomparableReason(snapshot: Snapshot, existing: Snapshot[]): string {
  const newest = existing[0]
  if (!newest) return 'no comparable build'
  if (newest.schemaVersion !== snapshot.schemaVersion) {
    return `they were written under snapshot schema v${newest.schemaVersion}, this one is v${snapshot.schemaVersion}`
  }
  if (newest.bundler !== snapshot.bundler) return `they were built with ${newest.bundler}, this one with ${snapshot.bundler}`
  const major = (version: string): string => version.split('.')[0] ?? version
  if (major(newest.nextVersion) !== major(snapshot.nextVersion)) {
    return `they were built on Next ${major(newest.nextVersion)}, this one on Next ${major(snapshot.nextVersion)}`
  }
  return 'they share no route with this build'
}

const buildCommandFor = (packageManager: string, app: NextApp): string =>
  app.hasBuildScript ? `${packageManager} run build` : 'npx next build'

const chosenBecause = (how: 'cwd' | 'only-app' | 'ambiguous' | 'none', count: number): string => {
  if (how === 'cwd') return 'The directory crust was pointed at.'
  return count === 1 ? 'The only Next.js app in this workspace.' : `Chosen from ${count} candidates.`
}

const describe = (root: string, cwd: string): string => relativePosix(root, cwd) || root


