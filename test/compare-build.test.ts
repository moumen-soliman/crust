import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildPair } from '../src/compare/build-pair.ts'
import { SnapshotStore } from '../src/store/store.ts'
import { route, snapshot } from './factories.ts'

const exec = promisify(execFile)
const git = (args: string[], cwd: string) => exec('git', args, { cwd })

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'basic')
/** A command that fails: used where the point is that it must never run, or must be reported. */
const FAILS = 'echo kaboom 1>&2; exit 3'

async function commit(cwd: string, message: string): Promise<string> {
  await git(['add', '-A'], cwd)
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message], cwd)
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

interface Repo {
  dir: string
  first: string
  second: string
}

/**
 * The situation this feature exists for: two named branches, and a third checkout
 * on top with uncommitted work. Every test asserts against that shape because it
 * is the one where checking a ref out is not an option.
 */
async function repo(prepare?: (step: 1 | 2, dir: string) => Promise<void>): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'crust-build-pair-'))
  await git(['init', '-q', '-b', 'first', dir], tmpdir())

  await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8')
  await prepare?.(1, dir)
  const first = await commit(dir, 'one')

  await git(['checkout', '-q', '-b', 'second'], dir)
  await writeFile(join(dir, 'a.txt'), 'two\n', 'utf8')
  await prepare?.(2, dir)
  const second = await commit(dir, 'two')

  await git(['checkout', '-q', '-b', 'wip'], dir)
  await writeFile(join(dir, 'a.txt'), 'uncommitted\n', 'utf8')

  return { dir, first, second }
}

/** Worktrees git still knows about, the main checkout included. */
async function worktreeCount(dir: string): Promise<number> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], dir)
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).length
}

const pair = (dir: string, overrides: Partial<Parameters<typeof buildPair>[0]> = {}) =>
  buildPair({ cwd: dir, baseRef: 'first', headRef: 'second', command: FAILS, toolVersion: 'test', ...overrides })

describe('resolving the two refs', () => {
  it('names a ref git does not know rather than substituting one', async () => {
    const { dir } = await repo()
    await expect(pair(dir, { baseRef: 'nope' })).rejects.toThrow(/does not know the base ref "nope"/)
  }, 30_000)

  it('refuses two refs that are the same commit', async () => {
    const { dir } = await repo()
    await expect(pair(dir, { baseRef: 'second', headRef: 'wip' })).rejects.toThrow(
      /the same commit[\s\S]*cannot be compared to itself/,
    )
  }, 30_000)

  it('refuses outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-build-pair-nogit-'))
    await expect(pair(dir)).rejects.toThrow(/not inside a git repository/)
  }, 30_000)

  it('refuses a dist directory outside the app, which both refs would share', async () => {
    const { dir } = await repo()
    await expect(pair(dir, { distDir: '/tmp/somewhere/.next' })).rejects.toThrow(
      /outside the app directory[\s\S]*same build/,
    )
    await expect(pair(dir, { distDir: '../elsewhere/.next' })).rejects.toThrow(/outside the app directory/)
  }, 30_000)
})

describe('a build that fails', () => {
  it('names which ref failed and shows the tail of its output', async () => {
    const { dir, first } = await repo()
    await expect(pair(dir)).rejects.toThrow(
      new RegExp(`build for base ref "first" \\(${first.slice(0, 8)}\\) failed[\\s\\S]*exited with 3[\\s\\S]*kaboom`),
    )
  }, 30_000)

  it('leaves no worktree behind and does not touch the checkout', async () => {
    const { dir } = await repo()
    await expect(pair(dir)).rejects.toThrow()

    expect(await worktreeCount(dir)).toBe(1)
    const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    expect(branch.trim()).toBe('wip')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('uncommitted\n')
  }, 30_000)
})

describe('dependencies in the worktree', () => {
  const lockfile = (step: 1 | 2, dir: string) =>
    writeFile(join(dir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# ${step}\n`, 'utf8')

  it('refuses to measure a ref whose lockfile is not the installed one', async () => {
    const { dir } = await repo(lockfile)
    await expect(pair(dir)).rejects.toThrow(
      /pnpm-lock\.yaml differs at base ref "first"[\s\S]*install[\s\S]*--frozen-lockfile/,
    )
    expect(await worktreeCount(dir)).toBe(1)
  }, 30_000)

  it('leaves a build command that installs to populate the worktree itself', async () => {
    const { dir, first } = await repo(lockfile)
    // The lockfile still differs; the command installs, so that is no longer a
    // reason to refuse - it is reported as the build failure it is.
    await expect(pair(dir, { command: `pnpm install --frozen-lockfile; ${FAILS}` })).rejects.toThrow(
      new RegExp(`build for base ref "first" \\(${first.slice(0, 8)}\\) failed`),
    )
  }, 30_000)
})

describe('snapshots already recorded at those commits', () => {
  it('reuses both instead of rebuilding', async () => {
    const { dir, first, second } = await repo()
    const store = new SnapshotStore(dir)
    await store.write(snapshot({ buildId: 'onfirst000000000', gitSha: first, branch: 'first' }))
    await store.write(snapshot({ buildId: 'onsecond00000000', gitSha: second, branch: 'second' }))

    // The build command would fail if it ran at all.
    const built = await pair(dir)
    expect(built).toEqual({ baseId: 'onfirst000000000', headId: 'onsecond00000000' })
  }, 30_000)

  it('rebuilds when the pair on disk was recorded from a dirty tree', async () => {
    const { dir, first, second } = await repo()
    const store = new SnapshotStore(dir)
    await store.write(snapshot({ buildId: 'onfirst000000000', gitSha: first, dirty: true }))
    await store.write(snapshot({ buildId: 'onsecond00000000', gitSha: second, dirty: true }))

    await expect(pair(dir)).rejects.toThrow(/build for base ref "first"/)
  }, 30_000)

  it('rebuilds when the snapshots at those commits describe another app', async () => {
    // One `.perf/` serves a whole monorepo, so a clean snapshot at the right commit
    // can belong to a package nobody named. Sharing no route with the other side is
    // what gives that away.
    const { dir, first, second } = await repo()
    const store = new SnapshotStore(dir)
    await store.write(
      snapshot({ buildId: 'onfirst000000000', gitSha: first, routes: [route({ id: 'apps/docs/app/page.tsx' })] }),
    )
    await store.write(
      snapshot({ buildId: 'onsecond00000000', gitSha: second, routes: [route({ id: 'apps/web/app/page.tsx' })] }),
    )

    await expect(pair(dir)).rejects.toThrow(/build for base ref "first"/)
  }, 30_000)

  it('rebuilds when the pair on disk cannot be compared to each other', async () => {
    const { dir, first, second } = await repo()
    const store = new SnapshotStore(dir)
    await store.write(snapshot({ buildId: 'onfirst000000000', gitSha: first, bundler: 'webpack' }))
    await store.write(snapshot({ buildId: 'onsecond00000000', gitSha: second, bundler: 'turbopack' }))

    await expect(pair(dir)).rejects.toThrow(/build for base ref "first"/)
  }, 30_000)
})

/**
 * The end of the plan's "done when": one call, two named tips, two snapshots in the
 * project's own store, and a checkout that never moved. The build command stands in
 * for `next build` by pointing the worktree at a build the fixture already carries -
 * what is under test is the orchestration, not Next.
 *
 * That build has to exist for these to mean anything: `ln -s` links a missing target
 * without complaint, so an unbuilt fixture reaches the analysis as "no build found"
 * and reads like a bug in the orchestration. Skipped when it is absent, and built by
 * CI's `fixtures` job before it runs `pnpm test` - the same gate the other tests
 * against a real build use.
 */
const fixtureBuilt = existsSync(join(FIXTURE, '.next', 'app-path-routes-manifest.json'))

describe.skipIf(!fixtureBuilt)('a pair built from two tips', () => {
  const SOURCE = ['app', 'components', 'lib', 'next.config.ts', 'package.json', 'tsconfig.json', 'next-env.d.ts', 'pnpm-lock.yaml']

  async function appRepo(): Promise<Repo> {
    const dir = await mkdtemp(join(tmpdir(), 'crust-build-pair-app-'))
    await git(['init', '-q', '-b', 'release', dir], tmpdir())
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n.next/\n.perf/\n', 'utf8')
    for (const entry of SOURCE) await cp(join(FIXTURE, entry), join(dir, entry), { recursive: true })
    // The install the worktrees will link to, exactly as a real checkout has one.
    await symlink(join(FIXTURE, 'node_modules'), join(dir, 'node_modules'), 'dir')
    const release = await commit(dir, 'release')

    await git(['checkout', '-q', '-b', 'feature'], dir)
    await writeFile(join(dir, 'lib', 'added.ts'), 'export const added = 1\n', 'utf8')
    const feature = await commit(dir, 'feature')

    await git(['checkout', '-q', '-b', 'wip'], dir)
    await writeFile(join(dir, 'lib', 'uncommitted.ts'), 'export const wip = 1\n', 'utf8')

    return { dir, first: release, second: feature }
  }

  it('writes both sides into one store and leaves HEAD where it was', async () => {
    const { dir, first, second } = await appRepo()
    const progress: string[] = []

    const built = await buildPair({
      cwd: dir,
      baseRef: 'release',
      headRef: 'feature',
      // Symlinked rather than copied: a 100 MB build directory twice per run is not
      // what this test is measuring.
      command: `ln -s '${join(FIXTURE, '.next')}' .next`,
      toolVersion: 'test',
      onProgress: (line) => progress.push(line),
    })

    expect(built.baseId).not.toBe(built.headId)

    const store = new SnapshotStore(dir)
    const stored = await store.list()
    expect(stored.map((s) => s.buildId).sort()).toEqual([built.baseId, built.headId].sort())

    const base = await store.read(built.baseId)
    const head = await store.read(built.headId)
    expect(base?.gitSha).toBe(first)
    expect(head?.gitSha).toBe(second)
    // A detached worktree is clean, so neither side carries the checkout's dirty work.
    expect(base?.dirty).toBe(false)
    expect(head?.dirty).toBe(false)
    // The ref the user named, not the "HEAD" a detached worktree reports.
    expect(base?.branch).toBe('release')
    expect(head?.branch).toBe('feature')
    expect(base?.routes.length).toBeGreaterThan(0)

    // What the diff path does next with these two ids.
    expect((await store.resolve(built.headId, dir, undefined, { exact: true }))?.buildId).toBe(built.headId)
    expect((await store.resolve(built.baseId, dir, head!, { exact: true }))?.buildId).toBe(built.baseId)

    const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    expect(branch.trim()).toBe('wip')
    expect(await readFile(join(dir, 'lib', 'uncommitted.ts'), 'utf8')).toContain('wip')
    expect(await worktreeCount(dir)).toBe(1)

    expect(progress.join('\n')).toMatch(/base {2}release@[0-9a-f]{8} {2}built in/)
  }, 30_000)

  it('builds both refs at once with --parallel and records the same pair', async () => {
    const { dir, first, second } = await appRepo()
    const built = await buildPair({
      cwd: dir,
      baseRef: 'release',
      headRef: 'feature',
      command: `ln -s '${join(FIXTURE, '.next')}' .next`,
      parallel: true,
      toolVersion: 'test',
    })

    const store = new SnapshotStore(dir)
    expect((await store.read(built.baseId))?.gitSha).toBe(first)
    expect((await store.read(built.headId))?.gitSha).toBe(second)
    expect(await worktreeCount(dir)).toBe(1)
  }, 30_000)
})
