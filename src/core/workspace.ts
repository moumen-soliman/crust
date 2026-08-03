import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { exists, readJson } from './fs.ts'

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock']

/**
 * The directory both bundlers anchor source paths against.
 *
 * In a monorepo the app's own directory is the wrong answer: `packages/ui/src/Chart.tsx`
 * ships into the app's bundle but lives several levels above it, so indexing only the
 * app directory finds zero first-party sources for exactly the code most worth blaming.
 */
export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir)
  let best = dir

  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      if (await exists(join(dir, marker))) best = dir
    }
    // Stop at the repository boundary. Without this the walk keeps finding stray
    // lockfiles in the user's home directory and anchors every source path there,
    // so `app/page.tsx` gets indexed as `code/crust/fixtures/basic/app/page.tsx`.
    if (await exists(join(dir, '.git'))) return best
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return best
}

export interface ProjectFileIndex {
  root: string
  /** Every source file, root-relative, POSIX separators. */
  files: ReadonlySet<string>
  /** Basename -> the files carrying it. Drives suffix matching in both directions. */
  byBasename: ReadonlyMap<string, readonly string[]>
}

/** Build an index from a known file list - used by tests and by `indexWorkspace`. */
export function createIndex(root: string, files: Iterable<string>): ProjectFileIndex {
  const set = new Set(files)
  const byBasename = new Map<string, string[]>()
  for (const file of set) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    const list = byBasename.get(base)
    if (list) list.push(file)
    else byBasename.set(base, [file])
  }
  return { root, files: set, byBasename }
}

const IGNORED = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo', '.vercel'])
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css|scss|sass|json)$/

/**
 * Index once per analysis and reuse. Only source-like extensions are kept - the
 * index exists to answer "is this source-map path our code", and a lockfile or a
 * PNG can never be the answer.
 */
export async function indexWorkspace(root: string): Promise<ProjectFileIndex> {
  const files = new Set<string>()

  const recurse = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.next')) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return recurse(full)
        if (SOURCE_EXT.test(entry.name)) files.add(toPosix(relative(root, full)))
      }),
    )
  }

  await recurse(root)
  return createIndex(root, files)
}

export const toPosix = (p: string): string => p.split('\\').join('/')

/** How a path is written everywhere crust reports one: workspace-relative, POSIX. */
export const relativePosix = (root: string, path: string): string => toPosix(relative(root, path))

/** Version of the `next` package resolved from the project, or null if absent. */
export async function readNextVersion(projectDir: string): Promise<string | null> {
  let dir = resolve(projectDir)
  for (;;) {
    const pkg = await readJson<{ version?: string }>(join(dir, 'node_modules', 'next', 'package.json'))
    if (pkg) return pkg.version ?? null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
