import type { ModuleGraph } from './module-graph.ts'
import type { BarrelCost, ClientBoundary } from '../store/snapshot.ts'

/**
 * What a route's *shape* costs, as opposed to what its code costs.
 *
 * File-granular attribution answers "which file shipped these bytes", which is
 * necessary and not sufficient: on a real app the answer is thirty small files
 * that each look reasonable, and the actual defect is one barrel import or one
 * provider mounted in the root layout. Both are properties of how modules are
 * wired rather than of any single module, so neither shows up until the graph
 * is asked directly.
 */

/** Everything reachable from `start` by import edges, optionally with one module cut out. */
export function reachableModules(graph: ModuleGraph, start: string, without?: string): Set<string> {
  const seen = new Set<string>()
  const queue = [start]

  while (queue.length > 0) {
    const file = queue.shift()!
    if (file === without || seen.has(file)) continue
    seen.add(file)
    for (const dep of graph.nodes.get(file)?.imports ?? []) {
      if (dep !== without && !seen.has(dep)) queue.push(dep)
    }
  }

  return seen
}

/**
 * What each barrel on this route drags in, and what that costs.
 *
 * `dragged` is proven rather than inferred: the graph is walked a second time
 * with the barrel removed, and a module counts only if it becomes unreachable.
 * A component the page imports directly *and* re-exports through a barrel is
 * therefore not the barrel's fault, and deleting the barrel import would save
 * exactly the bytes reported here.
 */
export function barrelCosts(
  graph: ModuleGraph,
  entryFile: string,
  modules: Record<string, number>,
): BarrelCost[] {
  const costs: BarrelCost[] = []
  const withEverything = reachableModules(graph, entryFile)

  for (const file of withEverything) {
    if (!isBarrel(graph, file)) continue

    const withoutBarrel = reachableModules(graph, entryFile, file)
    const dragged = [...withEverything].filter(
      (candidate) => candidate !== file && !withoutBarrel.has(candidate) && modules[candidate] !== undefined,
    )
    if (dragged.length === 0) continue

    costs.push({
      file,
      bytes: dragged.reduce((sum, candidate) => sum + (modules[candidate] ?? 0), 0),
      dragged: dragged.sort((a, b) => (modules[b] ?? 0) - (modules[a] ?? 0)),
    })
  }

  return costs.sort((a, b) => b.bytes - a.bytes)
}

/**
 * Where server rendering stops, and what each of those boundaries costs.
 *
 * A boundary owns everything below it: crossing `'use client'` puts the whole
 * subtree in the browser whether or not the page renders any of it. Charging
 * the subtree to the boundary rather than to its leaves is what makes the
 * number act on - you delete or defer one component, not thirty.
 */
export function boundaryCosts(graph: ModuleGraph, modules: Record<string, number>): ClientBoundary[] {
  const boundaries: ClientBoundary[] = []

  for (const node of graph.nodes.values()) {
    if (!node.isClientBoundaryRoot) continue

    const subtree = reachableModules(graph, node.file)
    const bytes = [...subtree].reduce((sum, file) => sum + (modules[file] ?? 0), 0)

    boundaries.push({
      file: node.file,
      // A `'use client'` module very often has no default export - shared UI is
      // written as `export function Chart()`. Falling back to the sole declared
      // component names the thing a reviewer would recognise; more than one and
      // there is no single answer, so the file path stands.
      component:
        node.facts.defaultExportName ??
        (node.facts.components.length === 1 ? node.facts.components[0]!.name : null),
      bytes,
    })
  }

  return boundaries.sort((a, b) => b.bytes - a.bytes)
}

/**
 * A module that declares nothing and only forwards other modules' exports.
 *
 * Same rule as the cause chains use, kept here because both answers have to
 * agree about what a barrel is - a report that marks a hop as a barrel and then
 * charges it nothing reads as a bug in the tool.
 */
export function isBarrel(graph: ModuleGraph, file: string): boolean {
  const node = graph.nodes.get(file)
  if (!node) return false
  if (node.imports.length === 0) return false
  return node.facts.components.length === 0 && node.facts.functions.length === 0
}
