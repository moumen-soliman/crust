import { createHash } from 'node:crypto'

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Short content address used for module dedupe and build ids. */
export function shortHash(input: string | Buffer, length = 16): string {
  return sha256(input).slice(0, length)
}

/**
 * Two-character shard prefix for on-disk layout (`builds/ab/ab3f91c2.json`).
 * Keeps directory sizes sane once a repo has thousands of snapshots.
 */
export function shardPath(id: string): string {
  return `${id.slice(0, 2)}/${id}`
}
