import { isAbsolute, dirname, join, relative, resolve } from 'node:path'
import { ResolverFactory } from 'oxc-resolver'
import { getTsconfig } from 'get-tsconfig'
import { readSourceFacts, type SourceFacts } from './source-file.ts'
import { toPosix, type ProjectFileIndex } from '../core/workspace.ts'

export interface ModuleNode {
  /** Workspace-relative path. */
  file: string
  facts: SourceFacts
  /** Workspace-relative paths of first-party imports. */
  imports: string[]
  /** Local component binding -> resolved first-party module and export. */
  componentImports: Record<string, { file: string; imported: string }>
  /**
   * `import * as services` -> the module behind `services`. Kept apart from
   * `componentImports` because which export a namespace member reads is not
   * knowable from the import, so these can only ever be followed wholesale.
   */
  namespaceImports: Record<string, string>
  /** Specifiers that could not be resolved, reported rather than ignored. */
  unresolvedImports: string[]
  /**
   * Distance from the route entry. A client boundary root is depth-marked so the
   * subtree below it can be attributed to the client bundle.
   */
  isClientBoundaryRoot: boolean
}

export interface ModuleGraph {
  entry: string
  nodes: Map<string, ModuleNode>
  warnings: string[]
}

/**
 * `react-server` first: a package can export a different module to the server
 * graph, and resolving without it silently analyses the client build of a
 * dependency that the server never loads.
 */
const CONDITIONS = ['node', 'react-server', 'import', 'require', 'default']
// `.d.ts` is listed so declaration-only aliases resolve. Types are erased before
// a bundler ever sees them, so these resolve successfully and are then dropped
// rather than walked. Without the extension, a package importing its own types
// through an alias reports hundreds of false "could not resolve" warnings -
// 272 of them on a real workspace.
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.d.ts', '.json']

/**
 * A resolver per tsconfig, chosen by which one governs the importing file.
 *
 * A single project-wide resolver is wrong in a monorepo: `packages/core` has its
 * own `paths`, so resolving its `@/types/X` against the app's tsconfig fails for
 * every file in the package. On a real workspace that produced 272 "could not
 * resolve" warnings for imports that are perfectly resolvable - just not from
 * where we were asking.
 */
export class ResolverPool {
  private readonly byConfig = new Map<string, ResolverFactory>()
  private readonly configForDir = new Map<string, string | null>()

  private readonly fallbackTsconfig: string | null

  constructor(fallbackTsconfig: string | null = null) {
    this.fallbackTsconfig = fallbackTsconfig
  }

  /** The resolver governing `fromDir`, based on the nearest enclosing tsconfig. */
  for(fromDir: string): ResolverFactory {
    const configPath = this.nearestTsconfig(fromDir) ?? this.fallbackTsconfig
    const key = configPath ?? '<none>'
    let resolver = this.byConfig.get(key)
    if (!resolver) {
      resolver = new ResolverFactory({
        extensions: EXTENSIONS,
        conditionNames: CONDITIONS,
        ...(configPath ? { tsconfig: { configFile: configPath, references: 'auto' as const } } : {}),
      })
      this.byConfig.set(key, resolver)
    }
    return resolver
  }

  private nearestTsconfig(fromDir: string): string | null {
    const cached = this.configForDir.get(fromDir)
    if (cached !== undefined) return cached

    const found = getTsconfig(fromDir)?.path ?? null
    this.configForDir.set(fromDir, found)
    return found
  }
}

export function createResolver(tsconfigPath: string | null): ResolverPool {
  return new ResolverPool(tsconfigPath)
}

/**
 * Walk the import graph from a route entry, first-party only.
 *
 * Descent stops at `node_modules` - a dependency's internals are not the user's
 * code and cannot be acted on, so following them would multiply the work without
 * changing any answer the tool gives.
 *
 * Crossing a `'use client'` file marks a boundary root but does not stop the walk:
 * everything below it still ships, and knowing which imports pulled it in is the
 * whole point of blaming a bundle-size regression on a module.
 */
/**
 * `.perf/overrides.json` - manual answers for specifiers the resolver cannot
 * settle (computed dynamic imports, exotic plugin-resolved aliases). Maps a
 * specifier to a workspace-relative file. The plan's position stands: do not
 * chase 100% resolution in code when a ten-line JSON file covers the tail.
 */
export type ImportOverrides = Record<string, string>

export async function buildModuleGraph(
  entryAbs: string,
  index: ProjectFileIndex,
  resolver: ResolverPool,
  overrides: ImportOverrides = {},
): Promise<ModuleGraph> {
  const nodes = new Map<string, ModuleNode>()
  const warnings: string[] = []
  const queue: { abs: string; clientAncestor: boolean }[] = [{ abs: entryAbs, clientAncestor: false }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { abs, clientAncestor } = queue.shift()!
    if (seen.has(abs)) continue
    seen.add(abs)

    const rel = toPosix(relative(index.root, abs))
    if (!index.files.has(rel)) continue

    const facts = await readSourceFacts(abs, rel)
    const imports: string[] = []
    const componentImports: Record<string, { file: string; imported: string }> = {}
    const namespaceImports: Record<string, string> = {}
    const unresolvedImports: string[] = []

    const recordBindings = (imp: (typeof facts.imports)[number], target: string): void => {
      for (const binding of imp.bindings) {
        if (!binding.local) continue
        if (binding.imported === '*') namespaceImports[binding.local] = target
        else componentImports[binding.local] = { file: target, imported: binding.imported }
      }
    }

    for (const imp of facts.imports) {
      if (imp.specifier.startsWith('node:')) continue

      const overridden = overrides[imp.specifier]
      if (overridden && index.files.has(overridden)) {
        imports.push(overridden)
        recordBindings(imp, overridden)
        queue.push({ abs: join(index.root, overridden), clientAncestor: clientAncestor || facts.isClientComponent })
        continue
      }

      const resolved = resolveSpecifier(resolver, dirname(abs), imp.specifier, index.root)
      if (!resolved) {
        // Bare specifiers are expected to be dependencies; only unresolvable
        // relative and aliased imports indicate a real gap in the analysis.
        if (imp.specifier.startsWith('.') || imp.specifier.startsWith('~') || imp.specifier.startsWith('@/')) {
          unresolvedImports.push(imp.specifier)
        }
        continue
      }
      if (resolved.includes('node_modules') || resolved.endsWith('.d.ts')) continue
      const resolvedRel = toPosix(relative(index.root, resolved))
      if (!index.files.has(resolvedRel)) continue
      imports.push(resolvedRel)
      recordBindings(imp, resolvedRel)
      queue.push({ abs: resolved, clientAncestor: clientAncestor || facts.isClientComponent })
    }

    nodes.set(rel, {
      file: rel,
      facts,
      imports,
      componentImports,
      namespaceImports,
      unresolvedImports,
      isClientBoundaryRoot: facts.isClientComponent && !clientAncestor,
    })

    if (unresolvedImports.length > 0) {
      warnings.push(`${rel}: could not resolve ${unresolvedImports.join(', ')}`)
    }
  }

  return { entry: toPosix(relative(index.root, entryAbs)), nodes, warnings }
}

function resolveSpecifier(
  resolver: ResolverPool,
  fromDir: string,
  specifier: string,
  root: string,
): string | null {
  try {
    const result = resolver.for(fromDir).sync(fromDir, specifier)
    if (!result.path) return null
    // tsconfig `paths` resolution can return a cwd-relative path.
    return isAbsolute(result.path) ? result.path : resolve(root, result.path)
  } catch {
    return null
  }
}

/**
 * Files whose *own* code touches a dynamic API or an uncached fetch, plus every
 * file that transitively imports one.
 *
 * Module granularity, not function granularity. That is coarser than ideal - a
 * cached helper sitting in the same file as an uncached one taints both - but it
 * never claims something is static when it isn't, which is the direction that
 * matters. Function-level narrowing is a later refinement, not a correctness fix.
 */
export interface TaintSite {
  reason: string
  /** Enclosing function, or null when the site runs at module scope. */
  inFunction: string | null
}

/**
 * The dynamic reads a module performs in its own code.
 *
 * Shared by the module-level propagation below and the per-export narrowing in
 * `reachableTaint`. The two must format reasons identically or the narrowing
 * filter silently matches nothing and quietly discards every reason it sees.
 */
export function directTaintSites(node: ModuleNode): TaintSite[] {
  const sites: TaintSite[] = []

  for (const api of node.facts.dynamicApis) {
    sites.push({ reason: `${api.name}() at ${node.file}:${api.line}`, inFunction: api.inFunction })
  }
  // A `'use cache'` function is cached however its fetches are written - the
  // directive is the caching, so flagging the fetch inside it would report a
  // regression on the exact pattern the framework is asking people to adopt.
  const cachedFunctions = new Set(node.facts.useCacheSites.map((s) => s.name))
  for (const f of node.facts.fetches) {
    if (f.inFunction && cachedFunctions.has(f.inFunction)) continue
    if (f.caching === 'default' || f.caching === 'no-store') {
      sites.push({ reason: `${UNCACHED_FETCH}${node.file}:${f.line}`, inFunction: f.inFunction })
    }
  }

  return sites
}

export function propagateDynamicTaint(graph: ModuleGraph): Map<string, string[]> {
  const direct = new Map<string, string[]>()

  for (const node of graph.nodes.values()) {
    const reasons = directTaintSites(node).map((s) => s.reason)
    if (reasons.length > 0) direct.set(node.file, reasons)
  }

  // Reverse edges, then propagate importer-wards until nothing changes.
  const importers = new Map<string, string[]>()
  for (const node of graph.nodes.values()) {
    for (const dep of node.imports) {
      const list = importers.get(dep) ?? []
      list.push(node.file)
      importers.set(dep, list)
    }
  }

  const tainted = new Map<string, string[]>(direct)
  const queue = [...direct.keys()]
  while (queue.length > 0) {
    const file = queue.shift()!
    const reasons = tainted.get(file) ?? []

    // `use cache` is a cache boundary, so a module that puts one in front of
    // everything it exports stops *cache* taint: an uncached `fetchJson` helper
    // wrapped by a cached `getProduct` one file up is cached by the time an
    // importer can observe it. Verified against two real builds of the same
    // fixture - the emitted shell is 100% static with the directive and 45%
    // without it, and before this the predictor said 45% both times.
    //
    // It stops nothing else. A cache cannot cache `cookies()`; Next rejects a
    // dynamic API inside `use cache` at build time, and if one is written anyway
    // the route still reads request state. Containing that would let a directive
    // silently hide the exact failure this tool exists to report, so dynamic-API
    // taint propagates through a contained module untouched.
    const escaping = containsCacheTaint(graph.nodes.get(file))
      ? reasons.filter((r) => !isUncachedFetch(r))
      : reasons
    if (escaping.length === 0) continue

    for (const importer of importers.get(file) ?? []) {
      const inherited = escaping.map((r) => (r.includes(' via ') ? r : `${r} via ${file}`))
      const merged = tainted.get(importer) ?? []

      // Union, not first-writer-wins. A module that reads `cookies()` itself and
      // also imports an uncached fetch has two independent reasons to be dynamic,
      // and dropping the second because the first arrived earlier means fixing
      // the one crust reported leaves the route dynamic for a reason it never
      // mentioned. Requeue only on a genuine addition, or the walk never settles.
      let added = false
      for (const reason of inherited) {
        if (merged.length >= MAX_REASONS_PER_FILE) break
        if (merged.includes(reason)) continue
        merged.push(reason)
        added = true
      }

      if (added) {
        tainted.set(importer, merged)
        queue.push(importer)
      }
    }
  }

  return tainted
}

/**
 * Merging turns taint into a union, and on a wide graph a shared utility can
 * otherwise accumulate every reason in the app. Only the first handful is ever
 * reported, so this bounds the work rather than the answer. Which reasons survive
 * past the cap depends on walk order - deterministic for a given graph, but
 * arbitrary - so the cap sits well above what any caller reads.
 */
const MAX_REASONS_PER_FILE = 32

/**
 * Reason strings are read back by `src/diff/reason.ts` to classify a change. The
 * prefix lives here because this is where it is written; that parser is a
 * consumer, and the analyzer must not depend on the diff layer to understand its
 * own output.
 */
const UNCACHED_FETCH = 'uncached fetch at '

const isUncachedFetch = (reason: string): boolean => reason.startsWith(UNCACHED_FETCH)

/**
 * Whether this module caches everything an importer can reach through it.
 *
 * True only when every single value it exports is a `use cache` function: then
 * the sole way in is through a cache, so whatever the module imports is cached
 * by the time it is observed. This governs *cache* taint only - see the call
 * site for why a dynamic API is never contained.
 *
 * The bar is deliberately all-or-nothing. One uncached export is enough to let
 * taint through, because module granularity cannot tell which export the
 * importer actually called - and the safe direction of that error is to keep
 * propagating. `export *` disqualifies a module outright: it exports names this
 * file cannot enumerate, so "every export is cached" is unknowable rather than
 * true.
 */
function containsCacheTaint(node: ModuleNode | undefined): boolean {
  if (!node) return false
  const exports = node.facts.exports
  if (exports.length === 0 || exports.includes('*')) return false

  const cached = new Set(node.facts.useCacheSites.map((s) => s.name))
  return exports.every((name) => cached.has(name))
}

/**
 * Reason strings carry a ` via <file>` suffix once they have been inherited.
 * Narrowing compares against the site itself, which does not.
 */
export const baseReason = (reason: string): string => reason.split(' via ')[0]!

/** How the walk got from one hop to the next. */
export type HopVia =
  /** A route export Next itself calls. */
  | 'entry'
  /** Code outside any function, which runs on import. */
  | 'module-scope'
  /** Another declaration in the same file. */
  | 'local'
  /** A resolved first-party import, named by its binding. */
  | 'import'
  /** `import * as ns` - the member read is unknowable. */
  | 'namespace'
  /** The precise answer ran out; this module's taint was taken whole. */
  | 'opaque'

export interface Hop {
  file: string
  /** The binding followed into this hop. */
  binding: string
  via: HopVia
}

export interface Reachability {
  /**
   * Site reason -> the hops from a route entry to it, entry first. The path is
   * what turns "this route is dynamic" into a chain someone can act on, so it
   * is recorded during the walk rather than reconstructed afterwards from a
   * graph that no longer knows which edge was taken.
   */
  reachable: Map<string, Hop[]>
  /**
   * Modules whose taint had to be taken wholesale because something on the path
   * could not be followed. Non-empty means the answer for those modules is the
   * old module-level one, and any conclusion drawn from it is inferred.
   */
  conservative: string[]
}

/**
 * Which dynamic reads a route's entry exports can actually reach.
 *
 * Module-level taint answers "does this file transitively import something
 * dynamic", which is the safe question but blames imports a route never calls:
 * `import { cachedProduct, liveProduct } from './services'` taints the route
 * through `liveProduct` even when only `cachedProduct` is ever referenced.
 *
 * This walks bindings instead of files. Anything it cannot follow - a computed
 * call, a namespace import, an export that is not a function it can see, a
 * module missing from the graph - falls back to taking that module's taint
 * whole and cascading the same treatment to its imports, which is exactly what
 * module-level taint already did. So this never adds a reason, only withholds
 * ones it can prove unreachable, and `conservative` names every place it could
 * not prove anything.
 */
export function reachableTaint(graph: ModuleGraph, entryFiles: string[]): Reachability {
  const reachable = new Map<string, Hop[]>()
  const conservative = new Set<string>()
  const visited = new Set<string>()
  const queue: { file: string; binding: string; path: Hop[] }[] = []

  // First path in wins. The queue is FIFO, so that is the shortest one - the
  // fewest hops a developer has to read to understand the same conclusion.
  const record = (reason: string, path: Hop[]): void => {
    if (!reachable.has(reason)) reachable.set(reason, path)
  }

  const takeWholeModule = (file: string, path: Hop[]): void => {
    if (conservative.has(file)) return
    conservative.add(file)

    const node = graph.nodes.get(file)
    if (!node) return
    const here = [...path, { file, binding: '*', via: 'opaque' as const }]
    for (const site of directTaintSites(node)) record(site.reason, here)
    // Cascade: if this module's reach is unknown, so is that of everything it
    // can hand back. That is module-level taint, restored exactly where the
    // precise answer ran out.
    for (const dep of node.imports) takeWholeModule(dep, here)
  }

  /** `binding` is a name as exported; returns the local declaration behind it. */
  const localBindingFor = (node: ModuleNode, exported: string): string | null => {
    if (exported === 'default') return node.facts.defaultExportName
    return node.facts.exportBindings[exported] ?? exported
  }

  const enqueue = (file: string, binding: string, path: Hop[], via: HopVia): void => {
    const key = `${file}::${binding}`
    if (visited.has(key)) return
    visited.add(key)
    queue.push({ file, binding, path: [...path, { file, binding, via }] })
  }

  /** Follow one resolved import edge to the declaration on the other side. */
  const followImport = (imported: { file: string; imported: string }, path: Hop[]): void => {
    const target = graph.nodes.get(imported.file)
    if (!target) return takeWholeModule(imported.file, path)
    const local = localBindingFor(target, imported.imported)
    if (!local) return takeWholeModule(imported.file, path)
    enqueue(imported.file, local, path, 'import')
  }

  // Import-time work runs for every importer whatever export they asked for, so
  // module-scope sites are reachable unconditionally and module-scope references
  // are entry points in their own right.
  for (const node of graph.nodes.values()) {
    const scope: Hop[] = [{ file: node.file, binding: '<module scope>', via: 'module-scope' }]
    for (const site of directTaintSites(node)) {
      if (site.inFunction === null) record(site.reason, scope)
    }
    for (const reference of node.facts.moduleScopeReferences) {
      resolveReference(node, reference, scope)
    }
  }

  // Next calls more than the default export: `generateMetadata` and friends run
  // for the same request and make the same route dynamic.
  for (const entry of entryFiles) {
    const node = graph.nodes.get(entry)
    if (!node) {
      conservative.add(entry)
      continue
    }
    for (const exported of node.facts.exports) {
      if (exported === '*') {
        takeWholeModule(entry, [])
        continue
      }
      enqueue(entry, localBindingFor(node, exported) ?? exported, [], 'entry')
    }
  }

  while (queue.length > 0) {
    const { file, binding, path } = queue.shift()!
    if (conservative.has(file)) continue

    const node = graph.nodes.get(file)
    if (!node) continue

    const fn = node.facts.functions.find((f) => f.name === binding)
    if (!fn) {
      // `export { getProduct } from './services'` declares nothing locally, only
      // an edge onwards - so follow it rather than condemning this module.
      const imported = node.componentImports[binding]
      if (imported) {
        followImport(imported, path)
        continue
      }
      const namespaced = node.namespaceImports[binding]
      if (namespaced) {
        takeWholeModule(namespaced, path)
        continue
      }
      // Not a function and not an edge. Only `export *` is genuinely unknown
      // here: it exports names this file cannot enumerate.
      //
      // Everything else is already covered. A value built at module scope -
      // `export const client = createClient()` - had its initialiser seeded as a
      // module-scope reference before the walk started, and a plain constant
      // reaches nothing at all. Treating those as unknown condemned the whole
      // module, which made `export const revalidate = 60` inherit every dynamic
      // read anywhere in its import graph.
      if (node.facts.exports.includes('*')) takeWholeModule(file, path)
      continue
    }

    for (const site of directTaintSites(node)) {
      if (site.inFunction !== binding) continue
      // Same containment rule the module-level pass applies: a cache cannot
      // cache `cookies()`, but it does cache the fetches written inside it.
      if (fn.isCached && site.reason.startsWith(UNCACHED_FETCH)) continue
      record(site.reason, path)
    }

    if (fn.opaque) {
      takeWholeModule(file, path)
      continue
    }

    for (const reference of fn.references) resolveReference(node, reference, path)
  }

  /** One reference out of a module: a sibling declaration, an import, or nothing. */
  function resolveReference(node: ModuleNode, reference: string, path: Hop[]): void {
    if (node.facts.functions.some((f) => f.name === reference)) {
      enqueue(node.file, reference, path, 'local')
      return
    }

    const imported = node.componentImports[reference]
    if (imported) {
      followImport(imported, path)
      return
    }

    // `import * as services` - which member gets read is not knowable from
    // the import, so the whole module has to count.
    const namespaceTarget = node.namespaceImports[reference]
    if (namespaceTarget) {
      takeWholeModule(namespaceTarget, [...path, { file: node.file, binding: reference, via: 'namespace' }])
    }
  }

  return { reachable, conservative: [...conservative].sort() }
}

/** `app/products/[slug]/page.tsx` -> the layout chain above it, nearest last. */
export function layoutChainFor(pageFile: string, index: ProjectFileIndex): string[] {
  const chain: string[] = []
  let dir = dirname(pageFile)
  for (;;) {
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      const candidate = toPosix(join(dir, `layout.${ext}`))
      if (index.files.has(candidate)) {
        chain.unshift(candidate)
        break
      }
    }
    const parent = dirname(dir)
    if (parent === dir || !dir.includes('/')) break
    dir = parent
  }
  return chain
}
