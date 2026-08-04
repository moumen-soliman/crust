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
