export type {
  Bundler,
  BundlerAdapter,
  AdapterContext,
  BuildAnalysis,
  RouteEntry,
  ChunkRef,
  ShellArtifact,
  RenderingMode,
  Known,
} from './adapters/types.ts'
export { known, unknown } from './adapters/types.ts'

export { deriveBuildId, newRunId, envFingerprint } from './core/build-id.ts'
export type { BuildIdentity, BuildIdInput, RunEnv } from './core/build-id.ts'

export { readGitContext, mergeBase, revList } from './core/git.ts'
export type { GitContext } from './core/git.ts'

export { sha256, shortHash, shardPath } from './core/hash.ts'

export { readSourceMap, resolveFirstParty, normalizeChunkList } from './analyze/source-map.ts'
export { findWorkspaceRoot, indexWorkspace, createIndex } from './core/workspace.ts'
export type { ProjectFileIndex } from './core/workspace.ts'
export { analyzeBuild } from './analyze/analyze.ts'
export type { Snapshot, RouteSnapshot, ShellSnapshot, Budgets } from './store/snapshot.ts'
