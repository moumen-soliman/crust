import { spawn } from 'node:child_process'
import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { analyzeBuild } from '../analyze/analyze.ts'
import { exists, readText } from '../core/fs.ts'
import { addWorktree, pruneWorktrees, removeWorktree, repoRoot, revParse } from '../core/git.ts'
import { shortHash } from '../core/hash.ts'
import { findWorkspaceRoot } from '../core/workspace.ts'
import { comparableBuilds } from '../diff/compatible.ts'
import { SnapshotStore } from '../store/store.ts'
import type { Snapshot } from '../store/snapshot.ts'

/**
 * Record both sides of a comparison from git refs, without touching the checkout.
 *
 * `crust diff a b` already compares two stored snapshots and rebuilds nothing.
 * The gap it leaves is the first run: someone has to have measured both refs, and
 * doing that by hand means two checkouts, two builds and a stash - on a branch
 * whose uncommitted work is the reason they wanted the comparison. This builds
 * each ref in its own detached worktree instead, writes both snapshots into the
 * project's single store, and hands the two build ids back to the existing diff.
 *
 * Nothing here renders or decides anything: the output of `--build` is two build
 * ids, and everything downstream is the same code path as `crust diff a b`.
 */

export const DEFAULT_BUILD_COMMAND = 'next build'

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

/** Tail of the build log kept for a failure message, in bytes. */
const OUTPUT_TAIL_BYTES = 64 * 1024
const OUTPUT_TAIL_LINES = 20

export interface BuildPairOptions {
  /** App directory - the analyze target, and the store/workspace anchor. */
  cwd: string
  baseRef: string
  headRef: string
  /** Shell command run in each worktree's app directory. */
  command?: string
  /** Build output directory, relative to the app directory in each worktree. */
  distDir?: string
  parallel?: boolean
  keepWorktrees?: boolean
  toolVersion: string
  onProgress?: (line: string) => void
}

export interface BuildPairResult {
  baseId: string
  headId: string
}

type SideName = 'base' | 'head'

interface Side {
  name: SideName
  /** What the user typed - kept for messages and for the snapshot's branch label. */
  ref: string
  sha: string
}

interface Worktree {
  side: Side
  /** Worktree root. */
  dir: string
  /** The app directory inside it: the worktree root plus the package path. */
  appDir: string
}

interface Context {
  repo: string
  workspaceRoot: string
  /** Package path inside the repository, '' for a single-app repo. */
  packagePath: string
  command: string
  distDir: string | undefined
  keepWorktrees: boolean
  toolVersion: string
  store: SnapshotStore
  progress: (line: string) => void
}

export async function buildPair(options: BuildPairOptions): Promise<BuildPairResult> {
  // Real paths on both sides of every comparison below. `git rev-parse
  // --show-toplevel` answers with the real path, and on macOS the temp directory
  // reaches the process as a symlink - so a project under it looks like it is
  // outside its own repository unless both are resolved the same way.
  const projectDir = await realPath(resolve(options.cwd))
  const repo = await realPathOrNull(await repoRoot(projectDir))
  if (!repo) {
    throw new Error(
      `${projectDir} is not inside a git repository, so there are no refs to build. ` +
        'Drop --build to compare snapshots already in the store.',
    )
  }

  const base = await resolveSide('base', options.baseRef, projectDir)
  const head = await resolveSide('head', options.headRef, projectDir)
  if (base.sha === head.sha) {
    throw new Error(
      `"${options.baseRef}" and "${options.headRef}" are the same commit (${short(base.sha)}). ` +
        'A build cannot be compared to itself.',
    )
  }

  const packagePath = inside(repo, projectDir)
  if (packagePath === null) {
    throw new Error(`--cwd ${projectDir} is outside the repository at ${repo}; the worktrees would have no such directory.`)
  }

  // Each ref is measured from the build inside its own worktree. A dist directory
  // that escapes the app - an absolute path, or one reached with `..` - would point
  // both sides at the same files, and two snapshots of one build compare as "no
  // change" with the same green tick a clean diff gets.
  if (options.distDir && inside(projectDir, resolve(projectDir, options.distDir)) === null) {
    throw new Error(
      `--dist-dir ${options.distDir} is outside the app directory, so both refs would be measured from the same build. ` +
        'Name a path inside it, relative to --cwd.',
    )
  }

  const workspaceRoot = await realPath(await findWorkspaceRoot(projectDir))
  const ctx: Context = {
    repo,
    workspaceRoot,
    packagePath,
    command: options.command ?? DEFAULT_BUILD_COMMAND,
    distDir: options.distDir,
    keepWorktrees: options.keepWorktrees ?? false,
    toolVersion: options.toolVersion,
    // One store for both sides: the project's own `.perf/`, exactly where
    // `crust analyze` would have written each of these snapshots by hand.
    store: new SnapshotStore(workspaceRoot),
    progress: options.onProgress ?? (() => {}),
  }

  const stored = await ctx.store.list()
  const candidates = {
    base: reusableAt(stored, base.sha),
    head: reusableAt(stored, head.sha),
  }

  // Rebuilding a commit that has already been measured is the cost this whole
  // feature exists to avoid, so a stored pair wins outright - but only as a pair.
  // Two snapshots at the right commits that cannot be compared to each other (a
  // bundler swap, a Next major, or another app in the same monorepo store) would
  // turn a rebuild into "not comparable", which reads like a verdict.
  const pair = reusablePair(candidates.base, candidates.head)
  if (pair) {
    ctx.progress(`${label(base)}  reusing snapshot ${pair.base.buildId}`)
    ctx.progress(`${label(head)}  reusing snapshot ${pair.head.buildId}`)
    return { baseId: pair.base.buildId, headId: pair.head.buildId }
  }

  const measured = new Map<SideName, Snapshot>()
  const toBuild =
    candidates.base.length > 0 && candidates.head.length > 0
      ? // Both sides are on disk and disagree with each other; neither is usable.
        [base, head]
      : [base, head].filter((side) => candidates[side.name].length === 0)

  if (options.parallel && toBuild.length > 1) await buildConcurrently(toBuild, ctx, measured)
  else for (const side of toBuild) measured.set(side.name, await buildOne(side, ctx))

  // A side that had candidates and was not built can still be reused - now there
  // is a freshly measured build to check it against.
  for (const side of [base, head]) {
    if (measured.has(side.name)) continue
    const other = measured.get(side.name === 'base' ? 'head' : 'base')!
    const match = candidates[side.name].find((candidate) => comparablePair(candidate, other))
    if (match) {
      ctx.progress(`${label(side)}  reusing snapshot ${match.buildId}`)
      measured.set(side.name, match)
    } else {
      measured.set(side.name, await buildOne(side, ctx))
    }
  }

  return { baseId: measured.get('base')!.buildId, headId: measured.get('head')!.buildId }
}

async function resolveSide(name: SideName, ref: string, cwd: string): Promise<Side> {
  const sha = await revParse(cwd, ref)
  if (!sha) {
    throw new Error(`git does not know the ${name} ref "${ref}". Fetch it, or name a branch, tag or commit that exists.`)
  }
  return { name, ref, sha }
}

/**
 * Builds one side end to end. The worktree lives exactly as long as the analysis
 * that reads its `.next`, and is removed even when the build fails - a failed run
 * leaving a full checkout and a half-written build directory behind is how a disk
 * fills up over a week of debugging.
 */
async function buildOne(side: Side, ctx: Context): Promise<Snapshot> {
  const worktree = await createWorktree(side, ctx)
  try {
    await runBuild(worktree, ctx)
    return await analyzeSide(worktree, ctx)
  } finally {
    await removeWorktreeDir(worktree, ctx)
  }
}

/**
 * `--parallel`: two worktrees, two builds at once, analyses still one at a time.
 * The builds are independent processes, so overlapping them is a straight win on a
 * machine with cores to spare. The analyses are not: they run in this process and
 * share a module-level chunk-size cache, so a second concurrent analysis would
 * read the first one's cache entries and attribute one build's bytes to the other.
 */
async function buildConcurrently(sides: Side[], ctx: Context, measured: Map<SideName, Snapshot>): Promise<void> {
  const worktrees: Worktree[] = []
  try {
    for (const side of sides) worktrees.push(await createWorktree(side, ctx))
    await Promise.all(worktrees.map((worktree) => runBuild(worktree, ctx)))
    for (const worktree of worktrees) measured.set(worktree.side.name, await analyzeSide(worktree, ctx))
  } finally {
    for (const worktree of worktrees) await removeWorktreeDir(worktree, ctx)
  }
}

/**
 * Worktrees live outside the repository, under the system temp directory.
 *
 * Inside it - `.perf/worktrees`, say - they would be indexed as project sources by
 * the next analysis that walks the workspace, so every source path in the app
 * would have a second candidate with the same basename and blame would start
 * naming files from a checkout of another commit.
 */
async function createWorktree(side: Side, ctx: Context): Promise<Worktree> {
  const dir = join(tmpdir(), 'crust-worktrees', shortHash(ctx.repo), `${side.name}-${side.sha.slice(0, 12)}`)

  // A killed run leaves both the directory and git's registration behind, and git
  // then refuses the path. Clearing both is what makes the retry work.
  await rm(dir, { recursive: true, force: true })
  await pruneWorktrees(ctx.repo)
  await mkdir(join(dir, '..'), { recursive: true })
  await addWorktree(ctx.repo, dir, side.sha)

  const worktree: Worktree = { side, dir, appDir: join(dir, ctx.packagePath) }
  if (!(await exists(worktree.appDir))) {
    await removeWorktreeDir(worktree, ctx)
    throw new Error(
      `${ctx.packagePath || '.'} does not exist at ${side.name} ref "${side.ref}" (${short(side.sha)}). ` +
        'Name the app directory that exists on both refs with --cwd.',
    )
  }

  await prepareDependencies(worktree, ctx)
  return worktree
}

/**
 * A fresh worktree has no `node_modules`, and nothing crust does can build
 * without one.
 *
 * Linking this checkout's install is the fast path and is correct exactly while
 * the ref's lockfile matches it. When it does not, the ref's dependencies are part
 * of what changed - measuring it against this checkout's `node_modules` would
 * report a bundle for a dependency set that ref never had - so crust refuses and
 * names the fix instead of guessing. A build command that installs is left alone:
 * it is populating the worktree itself.
 */
async function prepareDependencies(worktree: Worktree, ctx: Context): Promise<void> {
  if (installs(ctx.command)) return

  const lockfile = await lockfileMismatch(worktree, ctx)
  if (lockfile) {
    await removeWorktreeDir(worktree, ctx)
    throw new Error(
      `${lockfile} differs at ${worktree.side.name} ref "${worktree.side.ref}" (${short(worktree.side.sha)}), ` +
        "so this checkout's node_modules is not what that ref builds with.\n" +
        `  Build with an install step instead, e.g. --build 'pnpm install --frozen-lockfile && pnpm build'.`,
    )
  }

  // Every level that has an install: the workspace root holds the dependencies in
  // a pnpm/npm workspace, and the package directory holds its own `.bin` links.
  for (const dir of dependencyDirs(ctx)) {
    const source = join(ctx.repo, dir, 'node_modules')
    const target = join(worktree.dir, dir, 'node_modules')
    if (!(await exists(source)) || (await exists(target))) continue
    // A directory symlink, not a copy: the links inside a pnpm install are
    // relative to their real location, so they keep resolving through it.
    await mkdir(join(target, '..'), { recursive: true })
    await symlink(source, target, 'dir')
  }
}

/** Repository-relative directories that may carry an install, nearest last. */
function dependencyDirs(ctx: Context): string[] {
  const dirs = ['', inside(ctx.repo, ctx.workspaceRoot), ctx.packagePath]
  return [...new Set(dirs.filter((dir): dir is string => dir !== null))]
}

/** The lockfile whose contents differ between this checkout and the worktree, if any. */
async function lockfileMismatch(worktree: Worktree, ctx: Context): Promise<string | null> {
  const dir = inside(ctx.repo, ctx.workspaceRoot) ?? ''
  for (const name of LOCKFILES) {
    const here = await readText(join(ctx.repo, dir, name))
    if (here === null) continue
    const there = await readText(join(worktree.dir, dir, name))
    // A ref with no lockfile at all is not a mismatch this can reason about; the
    // build will say so far more clearly than a guess here would.
    return there !== null && there !== here ? join(dir, name) : null
  }
  return null
}

/** Whether the build command populates `node_modules` itself. */
function installs(command: string): boolean {
  return /\b(?:install|ci)\b/.test(command)
}

async function runBuild(worktree: Worktree, ctx: Context): Promise<void> {
  const { side } = worktree
  ctx.progress(`${label(side)}  building: ${ctx.command}`)
  const started = process.hrtime.bigint()

  let output: { code: number | null; log: string }
  try {
    output = await run(ctx.command, worktree, ctx)
  } catch (error) {
    // The command never started - no shell, no such binary. Named the same way a
    // failing build is: which ref, and what was run.
    throw new Error(
      `The build for ${side.name} ref "${side.ref}" (${short(side.sha)}) could not be started: ` +
        `\`${ctx.command}\` - ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9

  if (output.code !== 0) {
    throw new Error(
      `The build for ${side.name} ref "${side.ref}" (${short(side.sha)}) failed: ` +
        `\`${ctx.command}\` exited with ${output.code ?? 'a signal'}.\n${indent(tail(output.log))}`,
    )
  }
  ctx.progress(`${label(side)}  built in ${seconds.toFixed(1)}s`)
}

function run(command: string, worktree: Worktree, ctx: Context): Promise<{ code: number | null; log: string }> {
  // `node_modules/.bin` from the worktree, so a bare `next build` resolves the way
  // it would under a package-manager script - including after an install step that
  // only creates these directories once it runs.
  const path = [
    ...dependencyDirs(ctx).reverse().map((dir) => join(worktree.dir, dir, 'node_modules', '.bin')),
    process.env.PATH ?? '',
  ].join(delimiter)

  const child = spawn(command, {
    cwd: worktree.appDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: path, NEXT_TELEMETRY_DISABLED: '1' },
  })

  return new Promise((resolvePromise, reject) => {
    // Only the tail is kept. A Next build prints a few hundred lines nobody reads
    // when it succeeds, and the reason it failed is at the end when it does not.
    let log = ''
    const collect = (chunk: Buffer): void => {
      log = (log + chunk.toString()).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, log }))
  })
}

/**
 * Analyse the build in the worktree, store it in the project's `.perf/`.
 *
 * The identity comes out right without any help: a detached worktree's HEAD *is*
 * the ref's tip and its tree is clean, so `deriveBuildId` records that commit with
 * no dirty component - the same snapshot someone would get by checking the ref out
 * and running `crust analyze`.
 */
async function analyzeSide(worktree: Worktree, ctx: Context): Promise<Snapshot> {
  const { side } = worktree
  let snapshot: Snapshot
  try {
    snapshot = await analyzeBuild({
      cwd: worktree.appDir,
      ...(ctx.distDir ? { distDir: ctx.distDir } : {}),
      toolVersion: ctx.toolVersion,
    })
  } catch (error) {
    throw new Error(
      `Analysing the build for ${side.name} ref "${side.ref}" (${short(side.sha)}) failed: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }

  // git reports a detached worktree's branch as "HEAD", which in a diff header
  // reads as though both sides came from the same place. The ref the user named is
  // the honest label - unless they named the commit, and then the SHA already
  // beside it says everything.
  const stored: Snapshot = { ...snapshot, branch: side.sha.startsWith(side.ref) ? null : side.ref }
  await ctx.store.write(stored)
  ctx.progress(`${label(side)}  analysed ${stored.routes.length} routes → ${stored.buildId}`)
  return stored
}

async function removeWorktreeDir(worktree: Worktree, ctx: Context): Promise<void> {
  if (ctx.keepWorktrees) {
    ctx.progress(`${label(worktree.side)}  worktree kept at ${worktree.dir}`)
    return
  }
  try {
    await removeWorktree(ctx.repo, worktree.dir)
  } catch {
    // Cleanup is never the failure worth reporting: the snapshots are written and
    // the diff is the answer the user asked for. Drop the directory by hand and let
    // git forget the registration.
    await rm(worktree.dir, { recursive: true, force: true })
    await pruneWorktrees(ctx.repo)
  }
}

/** Stored snapshots of that exact commit, taken from a clean tree, newest first. */
function reusableAt(stored: Snapshot[], sha: string): Snapshot[] {
  return stored.filter((snapshot) => snapshot.gitSha === sha && !snapshot.dirty)
}

/**
 * Two snapshots that can stand in for a fresh pair: comparable as builds, and
 * describing the same app. Route overlap is the app test - one `.perf/` serves a
 * whole monorepo, so "a clean snapshot at that commit" alone can be another
 * package's build, and reusing it would answer about an app nobody named.
 */
function comparablePair(a: Snapshot, b: Snapshot): boolean {
  if (a.buildId === b.buildId) return false
  if (!comparableBuilds(a, b)) return false
  const ids = new Set(b.routes.map((route) => route.id))
  return a.routes.some((route) => ids.has(route.id))
}

function reusablePair(bases: Snapshot[], heads: Snapshot[]): { base: Snapshot; head: Snapshot } | null {
  for (const base of bases) {
    for (const head of heads) {
      if (comparablePair(base, head)) return { base, head }
    }
  }
  return null
}

async function realPath(dir: string): Promise<string> {
  try {
    return await realpath(dir)
  } catch {
    return dir
  }
}

async function realPathOrNull(dir: string | null): Promise<string | null> {
  return dir === null ? null : realPath(dir)
}

/** `dir` relative to `parent`, or null when it is not inside it. */
function inside(parent: string, dir: string): string | null {
  const rel = relative(parent, dir)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

const short = (sha: string): string => sha.slice(0, 8)

const label = (side: Side): string => `${side.name}  ${side.ref}@${short(side.sha)}`

const tail = (log: string): string => log.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n')

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
