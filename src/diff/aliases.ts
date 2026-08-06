import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RouteAliases } from './diff.ts'

/**
 * `.perf/aliases.json`, or an empty map when there is none.
 *
 * Shared rather than private to the CLI because every consumer that diffs has to
 * apply the same renames. A second reader that forgot them would report a moved
 * file as one route deleted and another added - the exact history break the
 * alias file exists to repair - and it would do it only on that surface.
 */
export async function readAliases(root: string): Promise<RouteAliases> {
  try {
    return JSON.parse(await readFile(join(root, '.perf', 'aliases.json'), 'utf8')) as RouteAliases
  } catch {
    return {}
  }
}
