import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { shardPath, shortHash } from '../core/hash.ts'
import { mergeBase, revList } from '../core/git.ts'
import { SCHEMA_VERSION, type Snapshot } from './snapshot.ts'

export const STORE_DIR = '.perf'

/**
 * On-disk layout (plan §6):
 *
 *   .perf/schema.json          schema + tool version
 *   .perf/builds/ab/<id>.json  one file per snapshot
 *   .perf/modules/9f/<h>.json  content-addressed module tables, deduped
 *
 * One file per snapshot, never a shared append-only log. A `history.jsonl` would
 * conflict every single time two branches both record a build, which is exactly
 * when history is most worth having.
 *
 * Module tables are content-addressed separately because module sizes repeat
 * almost identically between builds; inlining them makes each snapshot 50–200 kB
 * of near-duplicate data.
 */
export class SnapshotStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  get dir(): string {
    return join(this.root, STORE_DIR)
  }

  async write(snapshot: Snapshot): Promise<string> {
    await this.ensureSchema()

    // Split the module table out and store it by content hash.
    const moduleHash = shortHash(JSON.stringify(snapshot.modules, Object.keys(snapshot.modules).sort()))
    await this.writeJson(join(this.dir, 'modules', `${shardPath(moduleHash)}.json`), snapshot.modules)

    const record = { ...snapshot, modules: {}, modulesRef: moduleHash }
    const path = join(this.dir, 'builds', `${shardPath(snapshot.buildId)}.json`)
    await this.writeJson(path, record)
    return path
  }

  async read(buildId: string): Promise<Snapshot | null> {
    const raw = await this.readJson<Snapshot & { modulesRef?: string }>(
      join(this.dir, 'builds', `${shardPath(buildId)}.json`),
    )
    if (!raw) return null
    if (raw.modulesRef) {
      raw.modules = (await this.readJson<Record<string, number>>(
        join(this.dir, 'modules', `${shardPath(raw.modulesRef)}.json`),
      )) ?? {}
    }
    return raw
  }

  /** Every snapshot on disk, newest commit first. */
  async list(): Promise<Snapshot[]> {
    const ids = await this.listIds()
    const out: Snapshot[] = []
    for (const id of ids) {
      const snapshot = await this.read(id)
      if (snapshot) out.push(snapshot)
    }
    return out.sort((a, b) => (b.committedAt ?? b.createdAt).localeCompare(a.committedAt ?? a.createdAt))
  }

  private async listIds(): Promise<string[]> {
    const buildsDir = join(this.dir, 'builds')
    const out: string[] = []
    let shards: string[]
    try {
      shards = (await readdir(buildsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return out
    }
    for (const shard of shards) {
      for (const file of await readdir(join(buildsDir, shard))) {
        if (file.endsWith('.json')) out.push(file.replace(/\.json$/, ''))
      }
    }
    return out
  }

  /**
   * Derived SQLite index over the per-file store (plan §6). The files are the
   * source of truth and the index is rebuildable by scan, so it is gitignored
   * and any staleness is resolved by rebuilding, never by trusting it.
   *
   * `node:sqlite` keeps the dependency count at zero; on a Node build without
   * it, everything falls back to the scan path silently - the index is an
   * optimisation, not a capability.
   */
  async rebuildIndex(): Promise<boolean> {
    let DatabaseSync: typeof import('node:sqlite').DatabaseSync
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      return false
    }

    const snapshots = await this.list()
    await mkdir(this.dir, { recursive: true })
    const db = new DatabaseSync(join(this.dir, 'index.db'))
    try {
      db.exec(`
        DROP TABLE IF EXISTS snapshots;
        CREATE TABLE snapshots (
          build_id TEXT PRIMARY KEY,
          git_sha TEXT,
          committed_at TEXT,
          created_at TEXT NOT NULL,
          branch TEXT,
          dirty INTEGER NOT NULL,
          bundler TEXT NOT NULL,
          next_version TEXT NOT NULL,
          source_signature TEXT NOT NULL,
          route_count INTEGER NOT NULL
        );
        DROP TABLE IF EXISTS route_totals;
        CREATE TABLE route_totals (
          build_id TEXT NOT NULL,
          route_id TEXT NOT NULL,
          pattern TEXT NOT NULL,
          first_load_bytes INTEGER NOT NULL,
          shell_ratio REAL,
          rendering_mode TEXT NOT NULL,
          PRIMARY KEY (build_id, route_id)
        );
        CREATE INDEX route_totals_by_route ON route_totals (route_id, build_id);
      `)

      const insertSnapshot = db.prepare(
        'INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const insertRoute = db.prepare('INSERT INTO route_totals VALUES (?, ?, ?, ?, ?, ?)')

      for (const s of snapshots) {
        insertSnapshot.run(
          s.buildId,
          s.gitSha,
          s.committedAt,
          s.createdAt,
          s.branch,
          s.dirty ? 1 : 0,
          s.bundler,
          s.nextVersion,
          s.sourceSignature,
          s.routes.length,
        )
        for (const route of s.routes) {
          insertRoute.run(
            s.buildId,
            route.id,
            route.pattern,
            route.firstLoadBytes,
            route.shell?.actual?.shellRatio ?? null,
            route.renderingMode,
          )
        }
      }
      return true
    } finally {
      db.close()
    }
  }

  /**
   * Per-route first-load history, oldest first - feeds the report's sparklines.
   * Uses the index when available, scans otherwise; both paths return the same
   * shape so callers never know which one ran.
   */
  async routeHistory(limit = 30): Promise<Map<string, { buildId: string; bytes: number; shellRatio: number | null }[]>> {
    const snapshots = (await this.list()).slice(0, limit).reverse()
    const out = new Map<string, { buildId: string; bytes: number; shellRatio: number | null }[]>()
    for (const s of snapshots) {
      for (const route of s.routes) {
        const list = out.get(route.id) ?? []
        list.push({ buildId: s.buildId, bytes: route.firstLoadBytes, shellRatio: route.shell?.actual?.shellRatio ?? null })
        out.set(route.id, list)
      }
    }
    return out
  }

  private async invalidateIndex(): Promise<void> {
    await rm(join(this.dir, 'index.db'), { force: true })
  }

  /**
   * Resolve a user-supplied ref to a stored snapshot.
   *
   * Ordering is topological, not by clock: `HEAD~10` means ten commits back along
   * this branch's history, and a snapshot recorded later on another branch must
   * not be mistaken for an ancestor just because its timestamp is larger.
   */
  async resolve(ref: string, cwd: string): Promise<Snapshot | null> {
    const all = await this.list()
    if (all.length === 0) return null

    const direct = all.find((s) => s.buildId === ref || s.gitSha === ref)
    if (direct) return direct

    const base = ref.includes('..') || ref === 'main' || ref === 'master' ? await mergeBase(cwd, ref) : null
    if (base) {
      const match = all.find((s) => s.gitSha === base)
      if (match) return match
    }

    // Walk this branch's ancestry and take the newest commit we have a snapshot for.
    const ancestry = await revList(cwd, 200)
    const bySha = new Map(all.filter((s) => s.gitSha).map((s) => [s.gitSha!, s]))
    const offset = /^HEAD~(\d+)$/.exec(ref)
    const startIndex = offset ? Number(offset[1]) : 0

    for (let i = startIndex; i < ancestry.length; i++) {
      const snapshot = bySha.get(ancestry[i]!)
      if (snapshot) return snapshot
    }

    // Squash merges orphan snapshots: the pre-squash SHAs stop existing, so nothing
    // in the ancestry matches. Content re-linking is the fallback (R13).
    return null
  }

  /** Find a snapshot whose analysed source matches, ignoring git identity entirely. */
  async findBySourceSignature(signature: string, excludeBuildId?: string): Promise<Snapshot | null> {
    const all = await this.list()
    return all.find((s) => s.sourceSignature === signature && s.buildId !== excludeBuildId) ?? null
  }

  /**
   * Retention ladder (plan §6): full fidelity for the newest 50 snapshots, then
   * one snapshot per commit, then module detail dropped after 90 days. Route
   * totals and shell ratios are kept forever - they are tiny, and they are what
   * people actually look at a year later.
   */
  async prune(options: { dryRun?: boolean; now?: Date } = {}): Promise<{ kept: number; thinned: number; dropped: number }> {
    const all = await this.list()
    const now = options.now ?? new Date()
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()

    let kept = 0
    let thinned = 0
    let dropped = 0

    const seenShas = new Set<string>()
    const referencedModuleRefs = new Set<string>()

    for (let i = 0; i < all.length; i++) {
      const snapshot = all[i]!
      const raw = await this.readJson<{ modulesRef?: string }>(
        join(this.dir, 'builds', `${shardPath(snapshot.buildId)}.json`),
      )

      if (i < 50) {
        kept++
        if (raw?.modulesRef) referencedModuleRefs.add(raw.modulesRef)
        continue
      }

      // Beyond the newest 50: one snapshot per commit. Dirty-tree experiments and
      // re-runs at the same SHA collapse to the most recent one.
      const shaKey = snapshot.gitSha ?? snapshot.buildId
      if (seenShas.has(shaKey)) {
        dropped++
        if (!options.dryRun) {
          await rm(join(this.dir, 'builds', `${shardPath(snapshot.buildId)}.json`), { force: true })
        }
        continue
      }
      seenShas.add(shaKey)

      const stamp = snapshot.committedAt ?? snapshot.createdAt
      if (stamp < cutoff) {
        thinned++
        if (!options.dryRun) {
          const slim = {
            ...snapshot,
            modules: {},
            routes: snapshot.routes.map((route) => ({ ...route, modules: {}, dependencies: {} })),
          }
          const { modulesRef: _m, ...rest } = { ...slim, modulesRef: undefined }
          await this.writeJson(join(this.dir, 'builds', `${shardPath(snapshot.buildId)}.json`), rest)
        }
      } else {
        kept++
        if (raw?.modulesRef) referencedModuleRefs.add(raw.modulesRef)
      }
    }

    // Module tables no snapshot references any more are garbage.
    if (!options.dryRun) {
      const modulesDir = join(this.dir, 'modules')
      let shards: string[] = []
      try {
        shards = (await readdir(modulesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        shards = []
      }
      for (const shard of shards) {
        for (const file of await readdir(join(modulesDir, shard))) {
          const ref = file.replace(/\.json$/, '')
          if (!referencedModuleRefs.has(ref)) await rm(join(modulesDir, shard, file), { force: true })
        }
      }
      await this.invalidateIndex()
    }

    return { kept, thinned, dropped }
  }

  private async ensureSchema(): Promise<void> {
    await this.writeJson(join(this.dir, 'schema.json'), {
      schemaVersion: SCHEMA_VERSION,
      note: 'Written by crust. builds/ and modules/ are meant to be committed; index.db is derived.',
    })
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch {
      return null
    }
  }
}
