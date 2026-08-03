import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { defaultBranch, remoteUrl } from '../core/git.ts'
import { toPosix } from '../core/workspace.ts'

const NEXT_CONFIG_NAMES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
  'next.config.cts',
]

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.perf',
  'dist',
  'build',
  'out',
  'coverage',
])

export interface NextApp {
  dir: string
  /** Workspace-relative, POSIX separators. `.` when the app *is* the workspace root. */
  relativeDir: string
  packageName: string | null
  /** Whether package.json declares a `build` script - decides how CI builds it. */
  hasBuildScript: boolean
  /** A `next.config.*` sits here. Absent is legal, so this is evidence rather than a requirement. */
  hasConfig: boolean
}

/**
 * Every Next.js app in the workspace, shallowest first.
 *
 * Two independent signals, because either can be missing: a dependency on `next`
 * without a config file is the default shape of a new app, and a `next.config.*`
 * without a resolvable dependency is what a fresh clone looks like before
 * install. Depth is bounded because the answer is always within a couple of
 * levels (`apps/web`, `packages/site`) and walking a whole monorepo to find it
 * costs more than the command is worth.
 */
export async function findNextApps(root: string, maxDepth = 3): Promise<NextApp[]> {
  const apps: NextApp[] = []

  const visit = async (dir: string, depth: number): Promise<void> => {
    const app = await readApp(root, dir)
    if (app) apps.push(app)
    if (depth >= maxDepth) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => visit(join(dir, entry.name), depth + 1)),
    )
  }

  await visit(resolve(root), 0)
  return apps.sort((a, b) => a.relativeDir.length - b.relativeDir.length || a.relativeDir.localeCompare(b.relativeDir))
}

export interface AppChoice {
  app: NextApp | null
  candidates: NextApp[]
  /**
   * `cwd` - the directory crust was pointed at is the app.
   * `only-app` - one app in the workspace, so no question to ask.
   * `ambiguous` - several, and picking one for the user would silently analyse
   * the wrong product. The caller asks for `--cwd` instead.
   */
  how: 'cwd' | 'only-app' | 'ambiguous' | 'none'
}

/** Resolve which app to set up, or refuse to guess between several. */
export async function chooseNextApp(root: string, cwd: string): Promise<AppChoice> {
  const here = resolve(cwd)

  // The directory crust was pointed at, checked before the scan and independently
  // of it. The scan is bounded by depth and skips build output, so an app that
  // sits outside those bounds would otherwise lose to some unrelated app
  // elsewhere in the workspace - which is the one outcome worth failing over.
  const pointedAt = await readApp(root, here)

  const candidates = await findNextApps(root)
  if (pointedAt) {
    return {
      app: pointedAt,
      candidates: candidates.some((app) => app.dir === pointedAt.dir) ? candidates : [pointedAt, ...candidates],
      how: 'cwd',
    }
  }
  if (candidates.length === 0) return { app: null, candidates, how: 'none' }

  // Deepest containing app wins: in `apps/web/app` the answer is `apps/web`,
  // and a root-level app must never shadow the one the user is standing in.
  const containing = candidates
    .filter((app) => here === app.dir || here.startsWith(app.dir + '/'))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
  if (containing) return { app: containing, candidates, how: 'cwd' }

  if (candidates.length === 1) return { app: candidates[0]!, candidates, how: 'only-app' }
  return { app: null, candidates, how: 'ambiguous' }
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun'

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

export interface PackageManagerChoice {
  name: PackageManager
  /**
   * The version from the root `packageManager` field, when it names this same
   * manager. Its presence means CI should defer to it rather than pin a version
   * of its own: a workflow that installs pnpm 10 against a lockfile written by
   * pnpm 9 fails on `--frozen-lockfile`, and it fails on the wrong line.
   */
  declaredVersion: string | null
}

/** The lockfile decides; npm is the fallback because it needs no extra CI setup step. */
export async function detectPackageManager(root: string): Promise<PackageManagerChoice> {
  let name: PackageManager = 'npm'
  for (const [file, manager] of LOCKFILES) {
    if (await exists(join(root, file))) {
      name = manager
      break
    }
  }

  const pkg = await readJson<{ packageManager?: string }>(join(root, 'package.json'))
  const declared = pkg?.packageManager?.match(/^([a-z]+)@(\d[^\s+]*)/)
  return {
    name,
    declaredVersion: declared && declared[1] === name ? (declared[2] ?? null) : null,
  }
}

export type CiProvider = 'github' | 'gitlab' | 'circleci'

export interface CiDetection {
  provider: CiProvider | null
  /** How it was decided, printed so a wrong guess is obvious rather than mysterious. */
  how: string
}

/**
 * Prefer the CI directory that already exists; fall back to the remote host.
 *
 * The fallback matters more than it looks: a repository with no `.github/` yet
 * is exactly the repository that has never had a check, which is the one this
 * command exists for.
 */
export async function detectCiProvider(root: string): Promise<CiDetection> {
  if (await exists(join(root, '.github', 'workflows'))) return { provider: 'github', how: '.github/workflows exists' }
  if (await exists(join(root, '.gitlab-ci.yml'))) return { provider: 'gitlab', how: '.gitlab-ci.yml exists' }
  if (await exists(join(root, '.circleci', 'config.yml'))) return { provider: 'circleci', how: '.circleci/config.yml exists' }
  if (await exists(join(root, '.github'))) return { provider: 'github', how: '.github/ exists' }

  const remote = (await remoteUrl(root)) ?? ''
  if (remote.includes('github.com')) return { provider: 'github', how: 'origin points at github.com' }
  if (remote.includes('gitlab.com')) return { provider: 'gitlab', how: 'origin points at gitlab.com' }
  return { provider: null, how: 'no CI directory and no recognised remote' }
}

export interface NodeChoice {
  major: number
  how: string
}

/**
 * The Node version CI should run. `.nvmrc` and `engines` are statements the
 * project already made about itself, so they beat the version crust happens to
 * be running under.
 */
export async function detectNodeMajor(root: string, appDir: string): Promise<NodeChoice> {
  for (const dir of dedupe([appDir, root])) {
    const nvmrc = await read(join(dir, '.nvmrc'))
    const fromNvmrc = nvmrc?.match(/(\d+)/)?.[1]
    if (fromNvmrc) return { major: clampNode(Number(fromNvmrc)), how: `${label(root, dir)}.nvmrc` }
  }

  for (const dir of dedupe([appDir, root])) {
    const pkg = await readJson<{ engines?: { node?: string } }>(join(dir, 'package.json'))
    const fromEngines = pkg?.engines?.node?.match(/(\d+)/)?.[1]
    if (fromEngines) return { major: clampNode(Number(fromEngines)), how: `${label(root, dir)}package.json engines.node` }
  }

  // A stated version is honoured as stated, odd majors included. This one is not
  // stated: it is whatever the developer happens to run, and half of those are
  // odd-numbered releases that never become LTS and have no CI image to match.
  const running = clampNode(Number(process.versions.node.split('.')[0]))
  const lts = running % 2 === 0 ? running : running - 1
  return { major: Math.max(20, lts), how: 'the Node running crust, rounded to an LTS line' }
}

/** The branch pull requests target, which is the ref the CI baseline compares against. */
export async function detectBaseline(root: string): Promise<{ branch: string; how: string }> {
  const branch = await defaultBranch(root)
  // `main` over `master` when neither is discoverable: the check has to name
  // some ref, and this is the one a new repository gets.
  if (!branch) return { branch: 'main', how: 'no default branch found - assumed' }
  return { branch, how: 'default branch' }
}

async function readApp(root: string, dir: string): Promise<NextApp | null> {
  const pkg = await readJson<{
    name?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }>(join(dir, 'package.json'))

  const dependsOnNext = Boolean(pkg?.dependencies?.['next'] ?? pkg?.devDependencies?.['next'])
  let hasConfig = false
  for (const name of NEXT_CONFIG_NAMES) {
    if (await exists(join(dir, name))) {
      hasConfig = true
      break
    }
  }
  if (!dependsOnNext && !hasConfig) return null

  const rel = toPosix(relative(root, dir))
  return {
    dir,
    relativeDir: rel === '' ? '.' : rel,
    packageName: pkg?.name ?? null,
    hasBuildScript: Boolean(pkg?.scripts?.['build']),
    hasConfig,
  }
}

const clampNode = (major: number): number => (Number.isFinite(major) && major >= 20 ? major : 20)

const label = (root: string, dir: string): string => {
  const rel = toPosix(relative(root, dir))
  return rel === '' ? '' : `${rel}/`
}

const dedupe = (dirs: string[]): string[] => [...new Set(dirs)]

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const raw = await read(path)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
