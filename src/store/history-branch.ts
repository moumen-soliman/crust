import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { STORE_DIR } from './store.ts'

const exec = promisify(execFile)

export const HISTORY_BRANCH = 'perf-history'

export interface PushHistoryResult {
  pushed: boolean
  branch: string
  detail: string
}

/**
 * Publish `.perf/` snapshots to an orphan branch so CI has a baseline without
 * polluting the code history.
 *
 * Why an orphan branch and not the working branch: snapshots arrive on every
 * build of every PR, and interleaving those commits with code commits makes
 * `git log` unreadable and rebases painful. The orphan branch shares no history
 * with the code, so it can grow freely and be truncated freely.
 *
 * The work happens in a temporary worktree, never in the user's checkout — a
 * tool that switches the user's branch to write its own data is broken.
 *
 * Fork policy (open question in the plan, resolved here): pushes work for
 * same-repo branches only. A fork PR's GITHUB_TOKEN is read-only on the base
 * repo, so the push step reports and skips rather than failing the check —
 * the diff still works from any snapshots already on the branch.
 */
export async function pushHistory(repoRoot: string, options: { remote?: string } = {}): Promise<PushHistoryResult> {
  const remote = options.remote ?? 'origin'
  const perfDir = join(repoRoot, STORE_DIR)

  const hasRemote = await git(['remote', 'get-url', remote], repoRoot)
  if (hasRemote === null) {
    return { pushed: false, branch: HISTORY_BRANCH, detail: `no remote "${remote}" — snapshots stay local` }
  }

  // A worktree needs a commit to attach to; resolve whether the branch exists
  // anywhere first.
  await git(['fetch', remote, `${HISTORY_BRANCH}:refs/remotes/${remote}/${HISTORY_BRANCH}`], repoRoot)
  const remoteRef = await git(['rev-parse', '--verify', `refs/remotes/${remote}/${HISTORY_BRANCH}`], repoRoot)

  const worktree = await mkdtemp(join(tmpdir(), 'crust-history-'))
  // A throwaway local branch name, pushed to `perf-history` by refspec.
  //
  // Checking out `perf-history` locally looks tidier and breaks on the second
  // run: `--orphan` refuses when the branch already exists, and `-B` refuses
  // when another worktree has it checked out. Nothing needs a local branch —
  // `HEAD:perf-history` is the only thing the remote sees.
  const tempBranch = `crust-history-${Date.now().toString(36)}`

  try {
    if (remoteRef) {
      const added = await git(['worktree', 'add', '--detach', worktree, remoteRef], repoRoot)
      if (added === null) return { pushed: false, branch: HISTORY_BRANCH, detail: 'could not create a worktree' }
      await git(['checkout', '-b', tempBranch], worktree)
    } else {
      const added = await git(['worktree', 'add', '--detach', worktree], repoRoot)
      if (added === null) return { pushed: false, branch: HISTORY_BRANCH, detail: 'could not create a worktree' }
      // Orphan: no parent, no shared history with the code.
      await git(['checkout', '--orphan', tempBranch], worktree)
      await git(['rm', '-rf', '--ignore-unmatch', '.'], worktree)
    }

    await cp(perfDir, join(worktree, STORE_DIR), { recursive: true })
    // The index is derived and rebuildable; publishing it would just create
    // conflicts between machines that built it at different times.
    await rm(join(worktree, STORE_DIR, 'index.db'), { force: true })

    await git(['add', STORE_DIR], worktree)
    const status = await git(['status', '--porcelain'], worktree)
    if (!status) {
      return { pushed: false, branch: HISTORY_BRANCH, detail: 'no new snapshots to publish' }
    }

    const committed = await git(
      ['-c', 'user.name=crust', '-c', 'user.email=crust@localhost', 'commit', '-m', `crust: snapshot sync`],
      worktree,
    )
    if (committed === null) return { pushed: false, branch: HISTORY_BRANCH, detail: 'commit failed' }

    // Push from the repo root, not the worktree: a relative remote URL
    // (`../other.git`, common in submodules and test setups) resolves against the
    // repository directory, and from a worktree in /tmp it resolves to nothing.
    const pushed = await git(['push', remote, `${tempBranch}:${HISTORY_BRANCH}`], repoRoot)
    if (pushed === null) {
      return {
        pushed: false,
        branch: HISTORY_BRANCH,
        detail: 'push rejected — read-only token (fork PR?) or missing permission; snapshots stay local',
      }
    }

    return { pushed: true, branch: HISTORY_BRANCH, detail: `pushed to ${remote}/${HISTORY_BRANCH}` }
  } finally {
    await git(['worktree', 'remove', '--force', worktree], repoRoot)
    await rm(worktree, { recursive: true, force: true })
    // The temp branch outlives the worktree; leaving one behind per run would
    // litter the user's branch list.
    await git(['branch', '-D', tempBranch], repoRoot)
  }
}

/**
 * Pull snapshots from the history branch into the local `.perf/` so a fresh CI
 * checkout has a baseline to diff against. Local files win on conflict — the
 * local snapshot was produced by this build and is newer by construction.
 */
export async function fetchHistory(repoRoot: string, options: { remote?: string } = {}): Promise<PushHistoryResult> {
  const remote = options.remote ?? 'origin'

  await git(['fetch', remote, `${HISTORY_BRANCH}:refs/remotes/${remote}/${HISTORY_BRANCH}`], repoRoot)
  const remoteRef = await git(['rev-parse', '--verify', `refs/remotes/${remote}/${HISTORY_BRANCH}`], repoRoot)
  if (!remoteRef) {
    return { pushed: false, branch: HISTORY_BRANCH, detail: 'no history branch yet — first run records the baseline' }
  }

  const worktree = await mkdtemp(join(tmpdir(), 'crust-history-'))
  try {
    const added = await git(['worktree', 'add', '--detach', worktree, remoteRef], repoRoot)
    if (added === null) return { pushed: false, branch: HISTORY_BRANCH, detail: 'could not create a worktree' }
    await cp(join(worktree, STORE_DIR), join(repoRoot, STORE_DIR), { recursive: true, force: false }).catch(() => {
      // force:false throws when files exist; per-file "local wins" is exactly what we want.
    })
    return { pushed: true, branch: HISTORY_BRANCH, detail: `fetched snapshots from ${remote}/${HISTORY_BRANCH}` }
  } finally {
    await git(['worktree', 'remove', '--force', worktree], repoRoot)
    await rm(worktree, { recursive: true, force: true })
  }
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}
