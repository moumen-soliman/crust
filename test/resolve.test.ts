import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SnapshotStore } from '../src/store/store.ts'
import { snapshot } from './factories.ts'

const exec = promisify(execFile)
const git = (args: string[], cwd: string) => exec('git', args, { cwd })

const AUTHOR = ['-c', 'user.email=t@t', '-c', 'user.name=t']

async function commit(cwd: string, message: string): Promise<string> {
  await writeFile(join(cwd, 'file.txt'), message)
  await git(['add', 'file.txt'], cwd)
  await git([...AUTHOR, 'commit', '-q', '-m', message], cwd)
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

/**
 * A repository shaped like the one that exposed this: a shared trunk, a branch
 * that recorded a snapshot, and a second branch off that one which is checked
 * out and has recorded a snapshot of its own at HEAD.
 */
async function repo() {
  const work = await mkdtemp(join(tmpdir(), 'crust-resolve-'))
  await git(['init', '-q', '-b', 'trunk', work], tmpdir())

  const trunkSha = await commit(work, 'trunk')

  await git(['checkout', '-q', '-b', 'feature-a'], work)
  const featureSha = await commit(work, 'feature-a')

  await git(['checkout', '-q', '-b', 'feature-b'], work)
  const headSha = await commit(work, 'feature-b')

  const store = new SnapshotStore(work)
  const onFeatureA = snapshot({ buildId: 'bbbbbbbbbbbbbbbb', gitSha: featureSha, branch: 'feature-a' })
  const onHead = snapshot({ buildId: 'cccccccccccccccc', gitSha: headSha, branch: 'feature-b' })
  await store.write(onFeatureA)
  await store.write(onHead)

  return { work, store, trunkSha, featureSha, headSha, onFeatureA, onHead }
}

describe('SnapshotStore.resolve', () => {
  it('resolves a branch name that is neither main nor master', async () => {
    const { work, store, onFeatureA, onHead } = await repo()

    // The bug: only `main` and `master` were treated as branches, so every other
    // name fell through to a walk of HEAD's own ancestry.
    const base = await store.resolve('feature-a', work, onHead)
    expect(base?.buildId).toBe(onFeatureA.buildId)
  })

  it('never returns the head build as its own baseline', async () => {
    const { work, store, onHead } = await repo()

    // `analyze` writes a snapshot for the commit being measured, so the record
    // for HEAD is already stored. Returning it reported "0 changed" under the
    // same green tick a genuinely clean diff gets.
    for (const ref of ['feature-a', 'trunk', 'HEAD']) {
      const base = await store.resolve(ref, work, onHead)
      expect(base?.buildId).not.toBe(onHead.buildId)
    }
  })

  it('distinguishes two branches instead of answering both from HEAD', async () => {
    const { work, store, onHead, onFeatureA } = await repo()

    const fromFeature = await store.resolve('feature-a', work, onHead)
    const fromTrunk = await store.resolve('trunk', work, onHead)

    // `trunk` has no snapshot anywhere in its ancestry; `feature-a` has one.
    // Before the fix both returned whatever was newest on the current branch.
    expect(fromFeature?.buildId).toBe(onFeatureA.buildId)
    expect(fromTrunk).toBeNull()
  })

  it('returns null for a ref git does not know, rather than substituting one', async () => {
    const { work, store, onHead } = await repo()

    expect(await store.resolve('no-such-branch', work, onHead)).toBeNull()
  })

  it('prefers a clean snapshot over a dirty one at the same commit', async () => {
    const { work, store, featureSha, onHead } = await repo()
    await store.write(snapshot({ buildId: 'dddddddddddddddd', gitSha: featureSha, branch: 'feature-a', dirty: true }))

    const base = await store.resolve('feature-a', work, onHead)
    expect(base?.dirty).toBe(false)
  })
})
