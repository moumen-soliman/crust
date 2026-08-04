import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SnapshotStore } from '../src/store/store.ts'
import { snapshot } from './factories.ts'

const exec = promisify(execFile)
const git = (args: string[], cwd: string) => exec('git', args, { cwd })

/** Empty commits: resolution keys on SHAs, so the trees never need contents. */
async function commit(cwd: string, message: string): Promise<string> {
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message], cwd)
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

interface Repo {
  work: string
  store: SnapshotStore
  featureSha: string
  onFeatureA: ReturnType<typeof snapshot>
  onHead: ReturnType<typeof snapshot>
}

/**
 * A repository shaped like the one that exposed this: a shared trunk with no
 * snapshot, a branch that recorded one, and a second branch off it which is
 * checked out and has recorded a snapshot at HEAD.
 */
async function repo(): Promise<Repo> {
  const work = await mkdtemp(join(tmpdir(), 'crust-resolve-'))
  await git(['init', '-q', '-b', 'trunk', work], tmpdir())

  await commit(work, 'trunk')
  await git(['checkout', '-q', '-b', 'feature-a'], work)
  const featureSha = await commit(work, 'feature-a')
  await git(['checkout', '-q', '-b', 'feature-b'], work)
  const headSha = await commit(work, 'feature-b')

  const store = new SnapshotStore(work)
  const onFeatureA = snapshot({ buildId: 'bbbbbbbbbbbbbbbb', gitSha: featureSha, branch: 'feature-a' })
  const onHead = snapshot({ buildId: 'cccccccccccccccc', gitSha: headSha, branch: 'feature-b' })
  await store.write(onFeatureA)
  await store.write(onHead)

  return { work, store, featureSha, onFeatureA, onHead }
}

interface Diverged {
  work: string
  store: SnapshotStore
  featureSha: string
  onTrunk: ReturnType<typeof snapshot>
  onRelease: ReturnType<typeof snapshot>
  onFeature: ReturnType<typeof snapshot>
  onElsewhere: ReturnType<typeof snapshot>
}

/**
 * Three branches off a shared trunk, and the one that is checked out is none of
 * the ones being compared - the shape `crust diff <base> <head>` exists for.
 *
 * `release-next` sits on top of `release` with no snapshot of its own, so a walk
 * that follows the named ref's ancestry can be told apart from one that follows
 * the checkout's.
 */
async function divergedRepo(): Promise<Diverged> {
  const work = await mkdtemp(join(tmpdir(), 'crust-two-ref-'))
  await git(['init', '-q', '-b', 'trunk', work], tmpdir())

  const trunkSha = await commit(work, 'trunk')

  await git(['checkout', '-q', '-b', 'release'], work)
  const releaseSha = await commit(work, 'release')
  await git(['tag', 'v1.0'], work)

  await git(['checkout', '-q', '-b', 'release-next'], work)
  await commit(work, 'release-next')

  await git(['checkout', '-q', 'trunk'], work)
  await git(['checkout', '-q', '-b', 'feature'], work)
  const featureSha = await commit(work, 'feature')

  await git(['checkout', '-q', 'trunk'], work)
  await git(['checkout', '-q', '-b', 'elsewhere'], work)
  const elsewhereSha = await commit(work, 'elsewhere')

  const store = new SnapshotStore(work)
  const onTrunk = snapshot({ buildId: '1111111111111111', gitSha: trunkSha, branch: 'trunk' })
  const onRelease = snapshot({ buildId: '2222222222222222', gitSha: releaseSha, branch: 'release' })
  const onFeature = snapshot({ buildId: '3333333333333333', gitSha: featureSha, branch: 'feature' })
  const onElsewhere = snapshot({ buildId: '4444444444444444', gitSha: elsewhereSha, branch: 'elsewhere' })
  for (const record of [onTrunk, onRelease, onFeature, onElsewhere]) await store.write(record)

  return { work, store, featureSha, onTrunk, onRelease, onFeature, onElsewhere }
}

describe('SnapshotStore.resolve across two refs that are not checked out', () => {
  let shared: Diverged
  beforeAll(async () => { shared = await divergedRepo() }, 30_000)

  it('reads both sides from the refs while a third branch is checked out', async () => {
    const { work, store, onRelease, onFeature } = shared

    // What `crust diff feature release` has to answer. Neither ref is HEAD, and
    // `elsewhere` - which is - holds the newest snapshot in the store, so a
    // resolution that leaned on the checkout would be visible in both results.
    const head = await store.resolve('release', work, undefined, { exact: true })
    const base = await store.resolve('feature', work, head ?? undefined, { exact: true })

    expect(head?.buildId).toBe(onRelease.buildId)
    expect(base?.buildId).toBe(onFeature.buildId)
  }, 30_000)

  it('does not fall back to the point the checkout shares with the ref', async () => {
    const { work, store, onRelease, onTrunk } = shared

    // The bug this option exists for: `merge-base HEAD release` is the trunk
    // commit the two share, and the trunk has a snapshot - so the old path
    // answered "what is `release`" with a third build, confidently and quietly.
    expect((await store.resolve('release', work, undefined, { exact: true }))?.buildId).toBe(onRelease.buildId)
    expect((await store.resolve('release', work))?.buildId).toBe(onTrunk.buildId)
  }, 30_000)

  it('walks the named ref\'s own ancestry when its tip has no snapshot', async () => {
    const { work, store, onRelease, onElsewhere } = shared

    // `release-next` has none of its own. The answer is the newest snapshot it can
    // reach - which is on `release`, not the one on the branch in the worktree.
    const found = await store.resolve('release-next', work, undefined, { exact: true })
    expect(found?.buildId).toBe(onRelease.buildId)
    expect(found?.buildId).not.toBe(onElsewhere.buildId)
  }, 30_000)

  it('resolves a tag and a short SHA the same way as a branch', async () => {
    const { work, store, featureSha, onRelease, onFeature } = shared

    // "branch, commit, tag, or explicit snapshot" is the promise; a tag and an
    // abbreviated SHA both go through git rather than through a name pattern.
    expect((await store.resolve('v1.0', work, undefined, { exact: true }))?.buildId).toBe(onRelease.buildId)
    expect((await store.resolve(featureSha.slice(0, 8), work, undefined, { exact: true }))?.buildId).toBe(
      onFeature.buildId,
    )
  }, 30_000)

  it('still refuses a ref git does not know', async () => {
    const { work, store } = shared
    expect(await store.resolve('no-such-branch', work, undefined, { exact: true })).toBeNull()
  }, 30_000)
})

describe('SnapshotStore.resolve', () => {
  // Built once: every git call is a process spawn, and five of these in
  // parallel with the adapter suites is what made this file time out.
  let shared: Repo
  beforeAll(async () => { shared = await repo() }, 30_000)

  it('resolves a branch name that is neither main nor master', async () => {
    const { work, store, onFeatureA, onHead } = shared

    // The bug: only `main` and `master` were treated as branches, so every other
    // name fell through to a walk of HEAD's own ancestry.
    const base = await store.resolve('feature-a', work, onHead)
    expect(base?.buildId).toBe(onFeatureA.buildId)
  }, 30_000)

  it('never returns the head build as its own baseline', async () => {
    const { work, store, onHead } = shared

    // `analyze` writes a snapshot for the commit being measured, so the record
    // for HEAD is already stored. Returning it reported "0 changed" under the
    // same green tick a genuinely clean diff gets.
    for (const ref of ['feature-a', 'trunk', 'HEAD']) {
      const base = await store.resolve(ref, work, onHead)
      expect(base?.buildId).not.toBe(onHead.buildId)
    }
  }, 30_000)

  it('distinguishes two branches instead of answering both from HEAD', async () => {
    const { work, store, onHead, onFeatureA } = shared

    const fromFeature = await store.resolve('feature-a', work, onHead)
    const fromTrunk = await store.resolve('trunk', work, onHead)

    // `trunk` has no snapshot anywhere in its ancestry; `feature-a` has one.
    // Before the fix both returned whatever was newest on the current branch.
    expect(fromFeature?.buildId).toBe(onFeatureA.buildId)
    expect(fromTrunk).toBeNull()
  }, 30_000)

  it('returns null for a ref git does not know, rather than substituting one', async () => {
    const { work, store, onHead } = shared

    expect(await store.resolve('no-such-branch', work, onHead)).toBeNull()
  }, 30_000)

  // Its own repository: this one writes an extra snapshot, and sharing a store
  // across tests that mutate it makes the others depend on declaration order.
  it('prefers a clean snapshot over a dirty one at the same commit', async () => {
    const { work, store, featureSha, onHead } = await repo()
    await store.write(snapshot({ buildId: 'dddddddddddddddd', gitSha: featureSha, branch: 'feature-a', dirty: true }))

    const base = await store.resolve('feature-a', work, onHead)
    expect(base?.dirty).toBe(false)
  }, 30_000)
})
