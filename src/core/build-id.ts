import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { sha256, shortHash } from './hash.ts'
import { readGitContext, type GitContext } from './git.ts'
import type { Bundler } from '../adapters/types.ts'

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

export interface BuildIdentity {
  buildId: string
  gitSha: string | null
  dirty: boolean
  committedAt: string | null
  parentSha: string | null
  branch: string | null
  nextVersion: string
  nodeMajor: number
  bundler: Bundler
  /** Hash of the route table + module set - re-links snapshots orphaned by squash merges. */
  sourceSignature?: string
}

export interface BuildIdInput {
  cwd: string
  nextVersion: string
  bundler: Bundler
  /** Normalized next.config, already serialized. */
  configHash: string
  git?: GitContext
  /**
   * Content fingerprint used only when there is no git identity to key on.
   * Without it, `gitSha` and `dirtyHash` are both empty and every build of the
   * same project collapses into one id - so two genuinely different builds would
   * overwrite each other's snapshot.
   */
  contentFallback?: string
}

/**
 * A git SHA alone gives false continuity: bundle sizes move with lockfiles, Next
 * upgrades, Node versions and config edits at the same SHA. Everything that can
 * change the numbers goes into the identity (plan §6).
 */
export async function deriveBuildId(input: BuildIdInput): Promise<BuildIdentity> {
  const git = input.git ?? (await readGitContext(input.cwd))
  const lockfileHash = await hashLockfile(input.cwd)
  const nodeMajor = Number(process.versions.node.split('.')[0])

  const buildId = shortHash(
    [
      git.sha ?? `no-git:${input.contentFallback ?? ''}`,
      git.dirtyHash,
      lockfileHash,
      input.nextVersion,
      String(nodeMajor),
      input.bundler,
      input.configHash,
    ].join(':'),
  )

  return {
    buildId,
    gitSha: git.sha,
    dirty: git.dirtyHash !== '',
    committedAt: git.committedAt,
    parentSha: git.parentSha,
    branch: git.branch,
    nextVersion: input.nextVersion,
    nodeMajor,
    bundler: input.bundler,
  }
}

async function hashLockfile(cwd: string): Promise<string> {
  for (const name of LOCKFILES) {
    try {
      return shortHash(await readFile(join(cwd, name)))
    } catch {
      // Try the next candidate.
    }
  }
  return 'no-lockfile'
}

/** Sortable, unique per run. One build can be measured by many runs. */
export function newRunId(): string {
  return ulid()
}

/**
 * Runs with different env fingerprints must never be merged into one trend line -
 * a laptop on battery versus CI looks exactly like a regression that isn't one.
 */
export interface RunEnv {
  machine: string
  cpuCount: number
  throttle: string | null
  network: string | null
  coldStart: boolean
  browserVersion: string | null
}

export function envFingerprint(env: RunEnv): string {
  return sha256(
    [env.machine, env.cpuCount, env.throttle ?? '-', env.network ?? '-', env.coldStart, env.browserVersion ?? '-'].join(
      ':',
    ),
  ).slice(0, 12)
}
