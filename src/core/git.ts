import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sha256 } from './hash.ts'

const exec = promisify(execFile)

/**
 * Thin wrapper over the `git` binary. Deliberately not a dependency (plan §7):
 * git wrappers are a version-conflict report waiting to happen in someone
 * else's install, and we use six commands total.
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}

export interface GitContext {
  /** Full SHA of HEAD, or null outside a repo / on an empty repo. */
  sha: string | null
  /** Hash of the uncommitted diff, or '' when the tree is clean. */
  dirtyHash: string
  /** Author date of HEAD as an ISO string - survives rebase, unlike commit date. */
  committedAt: string | null
  parentSha: string | null
  branch: string | null
}

export async function readGitContext(cwd: string): Promise<GitContext> {
  const inRepo = (await git(['rev-parse', '--is-inside-work-tree'], cwd)) === 'true'
  if (!inRepo) {
    return { sha: null, dirtyHash: '', committedAt: null, parentSha: null, branch: null }
  }

  const [sha, committedAt, parentSha, branch, diff] = await Promise.all([
    git(['rev-parse', 'HEAD'], cwd),
    git(['log', '-1', '--format=%aI'], cwd),
    git(['rev-parse', 'HEAD^'], cwd),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['diff', 'HEAD'], cwd),
  ])

  return {
    sha,
    // The dirty component is the one that matters most: most measuring happens
    // on uncommitted work, and keying on SHA alone makes ten experiments
    // overwrite each other under one identity (plan §6).
    dirtyHash: diff ? sha256(diff).slice(0, 16) : '',
    committedAt,
    parentSha,
    branch,
  }
}

/** `git merge-base HEAD <ref>` - the anchor for "since main" comparisons. */
export async function mergeBase(cwd: string, ref: string): Promise<string | null> {
  return git(['merge-base', 'HEAD', ref], cwd)
}

/**
 * The branch pull requests target. `origin/HEAD` is the remote's own answer, so
 * it beats guessing between `main` and `master`; a local-only repository falls
 * back to whichever of the two exists. Null when neither does - the caller has
 * to name a ref, and inventing one silently is how a CI baseline points at
 * nothing.
 */
export async function defaultBranch(cwd: string): Promise<string | null> {
  const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
  if (symbolic) return symbolic.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if (await git(['rev-parse', '--verify', `refs/heads/${candidate}`], cwd)) return candidate
  }
  return null
}

/** A remote's URL - tells GitHub from GitLab in a repository with no CI directory yet. */
export async function remoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
  return git(['remote', 'get-url', remote], cwd)
}

/** Commits from HEAD backwards, newest first. Trend ordering is topological, not clock. */
export async function revList(cwd: string, limit: number): Promise<string[]> {
  const out = await git(['rev-list', `--max-count=${limit}`, 'HEAD'], cwd)
  return out ? out.split('\n') : []
}
