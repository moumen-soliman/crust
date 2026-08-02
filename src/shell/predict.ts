import type { ModuleGraph } from '../analyze/module-graph.ts'
import type { ComponentFacts } from '../analyze/source-file.ts'
import type { PredictedHole } from '../store/snapshot.ts'

export type ShellRuleSet = 'cache-components' | 'legacy-ppr'

export interface Prediction {
  predictedStatic: string[]
  predictedHoles: PredictedHole[]
  unknown: string[]
  /** Set when nothing can be prerendered at all, with the reason. */
  wholeRouteDynamic: string | null
}

interface Located {
  facts: ComponentFacts
  file: string
}

/**
 * Layer 1 of the shell engine: predict the static shell from source alone.
 *
 * This is the only layer that can answer *why*. The build output can tell you that
 * a route is partially prerendered; only source can tell you that an uncached call
 * three frames down in a utility is what pushed a component out of the shell.
 *
 * Two inverted rule sets share this code path (plan §5):
 *   legacy-ppr        static by default; a dynamic API opts out — loudly, at build time
 *   cache-components  dynamic by default; `use cache` opts in, and failure is silent
 *
 * The silent case is what this is built for: under Cache Components one uncached
 * fetch quietly shrinks the shell with no error anywhere.
 *
 * The walk starts at the route's default export and follows what each component
 * actually renders. Descending matters: a `<Suspense>` postpones its entire
 * subtree, not just its immediate child, so classifying components file-by-file
 * would report a grandchild of a boundary as part of the shell.
 */
export function predictShell(
  graph: ModuleGraph,
  taint: Map<string, string[]>,
  entryFile: string,
  ruleSet: ShellRuleSet,
): Prediction {
  const entry = graph.nodes.get(entryFile)
  if (!entry) {
    return { predictedStatic: [], predictedHoles: [], unknown: [], wholeRouteDynamic: 'route entry not analysable' }
  }

  // Component name -> where it is defined. First definition wins; a collision is
  // recorded rather than silently resolved to the wrong file.
  const index = new Map<string, Located>()
  const ambiguous = new Set<string>()
  for (const node of graph.nodes.values()) {
    for (const facts of node.facts.components) {
      if (index.has(facts.name)) ambiguous.add(facts.name)
      else index.set(facts.name, { facts, file: node.file })
    }
  }

  const predictedStatic = new Set<string>()
  const predictedHoles: PredictedHole[] = []
  const unknown = new Set<string>()
  let wholeRouteDynamic: string | null = null

  const root = entry.facts.defaultExportName
  if (!root || !index.has(root)) {
    return {
      predictedStatic: [],
      predictedHoles: [],
      unknown: [`${entryFile} has no statically resolvable default export`],
      wholeRouteDynamic: null,
    }
  }

  const visited = new Set<string>()

  /** Walk the shell side of the tree. Returns nothing; results accumulate above. */
  const walkStatic = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)

    const located = index.get(name)
    if (!located) {
      // Not a component we can see. It may be a host element (already filtered),
      // a dependency's component, or one arriving through props.
      return
    }
    if (ambiguous.has(name)) {
      unknown.add(`${name} is defined in more than one file; cannot tell which one renders here`)
      return
    }

    const node = graph.nodes.get(located.file)
    if (node?.facts.isClientComponent) {
      // A client component still renders on the server for the initial HTML, so
      // it belongs to the shell; its own children are React's problem, not ours.
      predictedStatic.add(name)
      return
    }

    const reason = ownTaint(located)
    if (reason) {
      // A dynamic read with no boundary above it takes the whole route with it.
      wholeRouteDynamic ??= reason
      predictedHoles.push({ component: name, boundary: '<route>', reason })
      return
    }

    predictedStatic.add(name)

    if (located.facts.hasOpaqueChildren && !isLayout(located.file)) {
      // A layout rendering `{children}` is resolvable by file convention — the
      // page below it is the child. Anywhere else, a component held in a variable
      // or arriving as a prop is not lexically resolvable and is reported as such.
      unknown.add(`${name} at ${located.file} renders a component it receives rather than names`)
    }

    for (const child of located.facts.renders) {
      if (isIntrinsic(child)) continue
      walkStatic(child)
    }

    for (const boundary of located.facts.suspense) {
      for (const child of boundary.children) {
        if (isIntrinsic(child)) continue
        markPostponed(child, `${located.file}:${boundary.line}`)
      }
    }
  }

  /**
   * A component sitting inside a `<Suspense>` is not automatically a hole.
   *
   * If everything it reads is cached, the build prerenders it *through* the
   * boundary and it lands in the shell — verified against real output: adding
   * `use cache` to the fixture's loader takes the route from a 45% shell to 100%
   * while the boundary stays exactly where it was.
   *
   * So a boundary only produces a hole when something under it is genuinely
   * dynamic. Treating every boundary as a hole would report a shell regression on
   * every route that uses Suspense correctly.
   */
  const markPostponed = (name: string, boundary: string): void => {
    if (visited.has(name)) return
    visited.add(name)

    const located = index.get(name)
    const reason = located ? (ownTaint(located) ?? firstReason(taint.get(located.file))) : null

    if (!reason) {
      if (located) predictedStatic.add(name)
      else unknown.add(`${name} inside the boundary at ${boundary} is not resolvable to a source file`)
      if (!located) return
      for (const child of located.facts.renders) {
        if (isIntrinsic(child)) continue
        markPostponed(child, boundary)
      }
      return
    }

    predictedHoles.push({ component: name, boundary, reason })

    if (!located) return
    for (const child of located.facts.renders) {
      if (isIntrinsic(child)) continue
      markPostponed(child, boundary)
    }
    for (const nested of located.facts.suspense) {
      for (const child of nested.children) {
        if (isIntrinsic(child)) continue
        markPostponed(child, `${located.file}:${nested.line}`)
      }
    }
  }

  /** Only the component's *own* body — inherited taint is handled by the tree walk. */
  function ownTaint(located: Located): string | null {
    const node = graph.nodes.get(located.file)
    const api = node?.facts.dynamicApis.find((a) => a.inFunction === located.facts.name)
    if (api) return `${api.name}() at ${located.file}:${api.line}`

    const uncached = node?.facts.fetches.find(
      (f) => f.inFunction === located.facts.name && (f.caching === 'default' || f.caching === 'no-store'),
    )
    if (uncached) return `uncached fetch at ${located.file}:${uncached.line}`

    // Deliberately not inferring taint from imports here. Module-level taint says
    // "this file transitively reaches something dynamic", which is true of a root
    // layout in almost every real app — it imports a shared service somewhere. On
    // a real 25-route codebase that inference reported `<RootLayout>` as a hole on
    // every single route. Transitive taint still drives boundary children, where
    // it is the right granularity; it must not condemn a component outright.
    return null
  }

  // Layouts wrap the page, so they are shell too unless they are tainted.
  for (const node of graph.nodes.values()) {
    if (!isLayout(node.file)) continue
    const name = node.facts.defaultExportName
    if (name) walkStatic(name)
  }
  walkStatic(root)

  const holeNames = new Set(predictedHoles.map((h) => h.component))
  return {
    predictedStatic: [...predictedStatic].filter((n) => !holeNames.has(n)).sort(),
    predictedHoles,
    unknown: [...unknown],
    wholeRouteDynamic,
  }
}

function firstReason(reasons: string[] | undefined): string | null {
  return reasons && reasons.length > 0 ? reasons[0]! : null
}

/**
 * Under Cache Components, sitting inside a boundary with nothing cached above is
 * itself the reason — there is no error and no single call site to point at.
 */
function defaultBoundaryReason(ruleSet: ShellRuleSet): string {
  return ruleSet === 'cache-components'
    ? 'not cached — Cache Components postpones anything without `use cache`'
    : 'rendered inside a Suspense boundary'
}

const isIntrinsic = (name: string): boolean => /^[a-z]/.test(name)
const isLayout = (file: string): boolean => /(?:^|\/)layout\.[jt]sx?$/.test(file)
