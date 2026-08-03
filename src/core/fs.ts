import { readFile, stat } from 'node:fs/promises'

/**
 * Reads that treat absence as an answer rather than an error.
 *
 * Every caller here is asking "is this project shaped like X" - is there a
 * lockfile, a config, a build - where missing is a normal outcome. Three copies of
 * these had grown across the tree, each with its own idea of what to swallow.
 */

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readText(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
