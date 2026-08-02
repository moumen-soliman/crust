import type { Hop, ModuleGraph } from './module-graph.ts'
import { isBarrel } from './shape.ts'
import type { CauseChain, CauseLink, Evidence } from '../store/snapshot.ts'

/**
 * Turning a reached site into something a developer can act on.
 *
 * The taint walk already knows which bindings it followed; this renders that
 * path as the chain the roadmap asks for - route, the nearest component the
 * evidence supports, every import hop with the binding that was actually
 * written, and the call at the end.
 *
 * Nothing here infers a hop. When the walk had to take a module wholesale the
 * chain says so and stops, because a plausible-looking chain that skips the
 * segment nobody could resolve is worse than an honest gap.
 */

export interface BuildCauseOptions {
  route: string
  graph: ModuleGraph
  /** Entry file the chain starts from. */
  entryFile: string
  /** Site reason, e.g. `uncached fetch at lib/http.ts:12`. */
  reason: string
  path: Hop[]
  /** True when the emitted build confirms the conclusion, not just the source. */
  confirmedByArtifact: boolean
}

export function buildCauseChain(options: BuildCauseOptions): CauseChain {
  const { route, graph, entryFile, reason, path, confirmedByArtifact } = options

  const links: CauseLink[] = []
  let component: string | null = null
  let unresolved: string | null = null

  for (const hop of path) {
    if (hop.via === 'opaque') {
      unresolved = `${hop.file} could not be narrowed to a single export; its taint is taken whole`
      break
    }
    if (hop.via === 'namespace') {
      unresolved = `${hop.file} reads \`${hop.binding}\` as a namespace; the member is not knowable from the import`
      break
    }

    // The deepest hop that is a component the source actually declares. A
    // service file three frames down is the cause, but the component is what a
    // reviewer recognises, so it is named separately as well as kept in place.
    const isComponentHop = isComponent(graph, hop)
    if (isComponentHop) component = hop.binding

    links.push({
      file: hop.file,
      binding: hop.binding,
      via: hop.via,
      barrel: isBarrel(graph, hop.file),
      component: isComponentHop,
    })
  }

  const site = parseSite(reason)

  return {
    route,
    entryFile,
    component,
    links,
    site: site.location,
    detail: site.detail,
    evidence: evidenceFor({ confirmedByArtifact, complete: unresolved === null }),
    unresolved,
  }
}

/**
 * Evidence is about what backs the conclusion, not how confident it feels.
 *
 * `verified` needs an emitted artifact to agree - the build really did opt this
 * route out, or really did ship these bytes. Source analysis alone is
 * `inferred` however clean the chain looks, and a chain with a gap in it is
 * `unknown` no matter what the build says, because the part that would make it
 * actionable is the part that is missing.
 */
function evidenceFor({ confirmedByArtifact, complete }: { confirmedByArtifact: boolean; complete: boolean }): Evidence {
  if (!complete) return 'unknown'
  return confirmedByArtifact ? 'verified' : 'inferred'
}

/** `uncached fetch at lib/http.ts:12` -> the two halves, kept separate for JSON. */
function parseSite(reason: string): { detail: string; location: string | null } {
  const match = /^(.*?) at (\S+:\d+)$/.exec(reason.split(' via ')[0]!)
  if (!match) return { detail: reason, location: null }
  return { detail: match[1]!, location: match[2]! }
}

function isComponent(graph: ModuleGraph, hop: { file: string; binding: string }): boolean {
  return Boolean(graph.nodes.get(hop.file)?.facts.components.some((c) => c.name === hop.binding))
}

/**
 * Worth marking because a barrel is rarely what anyone intended to import, and
 * naming it as the hop is usually the whole explanation for both an oversized
 * client bundle and a route that inherited taint it never asked for. Defined in
 * `shape.ts` so the hop label and the cost charged to it cannot disagree.
 */

/**
 * Why a route ships a particular first-party module to the browser.
 *
 * The dynamic chain follows what a route *calls*; this follows what it *drags
 * in*, which is a different question with a different answer - the barrel that
 * costs 221 kB is usually never called at all.
 */
export function buildBytesCause(options: {
  route: string
  graph: ModuleGraph
  entryFile: string
  file: string
  bytes: number
}): CauseChain {
  const { route, graph, entryFile, file, bytes } = options
  const links = importPathTo(graph, entryFile, file)
  const barrel = links?.find((link) => link.barrel)

  return {
    route,
    entryFile,
    component: nearestComponent(graph, links ?? []),
    links: links ?? [],
    site: file,
    detail: barrel ? `${kb(bytes)} through barrel import ${barrel.file}` : `${kb(bytes)} of client JavaScript`,
    // Bytes come from the emitted chunk and its source map, so the cost is
    // measured. Only the path explaining it can be missing.
    evidence: links ? 'verified' : 'unknown',
    unresolved: links ? null : `no import path from ${entryFile} to ${file}; it may arrive through a chunk this route shares`,
  }
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`

function nearestComponent(graph: ModuleGraph, links: CauseLink[]): string | null {
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i]!
    if (isComponent(graph, link)) return link.binding
  }
  return null
}

/**
 * The import path from a route entry to one module, with the binding written at
 * each hop. This is the client-JS counterpart to the taint walk: the question
 * is not what a route calls but what it drags into the browser, so it follows
 * import edges rather than references.
 *
 * Breadth-first, so the chain returned is the shortest explanation rather than
 * whichever one the graph happens to yield first.
 */
export function importPathTo(graph: ModuleGraph, entryFile: string, targetFile: string): CauseLink[] | null {
  if (entryFile === targetFile) return []

  const cameFrom = new Map<string, { from: string; binding: string }>()
  const seen = new Set([entryFile])
  const queue = [entryFile]

  while (queue.length > 0) {
    const file = queue.shift()!
    const node = graph.nodes.get(file)
    if (!node) continue

    for (const dep of node.imports) {
      if (seen.has(dep)) continue
      seen.add(dep)
      cameFrom.set(dep, { from: file, binding: bindingInto(node, dep) })
      if (dep === targetFile) return reconstruct(graph, cameFrom, entryFile, targetFile)
      queue.push(dep)
    }
  }

  return null
}

function reconstruct(
  graph: ModuleGraph,
  cameFrom: Map<string, { from: string; binding: string }>,
  entryFile: string,
  targetFile: string,
): CauseLink[] {
  const links: CauseLink[] = []
  let current = targetFile

  while (current !== entryFile) {
    const step = cameFrom.get(current)
    if (!step) break
    links.unshift({
      file: current,
      binding: step.binding,
      via: 'import',
      barrel: isBarrel(graph, current),
      component: isComponent(graph, { file: current, binding: step.binding }),
    })
    current = step.from
  }

  return links
}

/**
 * The chain as display lines, in the roadmap's arrow form.
 *
 * Shared by the terminal, the HTML report and the CI comment so a chain reads
 * the same everywhere. Callers decide how much of it to show - the terminal
 * takes the head and tail, the report takes all of it - but none of them get to
 * invent their own spelling of the same evidence.
 */
export function causeChainLines(chain: CauseChain): string[] {
  const lines: string[] = [chain.route]

  for (const link of chain.links) {
    if (link.component) lines.push(`<${link.binding}>`)
    else if (link.barrel) lines.push(`barrel import ${link.file}`)
    else lines.push(`${link.binding} · ${link.file}`)
  }

  lines.push(chain.site ? `${chain.detail} at ${chain.site}` : chain.detail)
  if (chain.unresolved) lines.push(`unresolved: ${chain.unresolved}`)

  return lines
}

/** The name written at the import site that leads to `dep`, when there is one. */
function bindingInto(node: { componentImports: Record<string, { file: string }>; namespaceImports: Record<string, string> }, dep: string): string {
  for (const [local, target] of Object.entries(node.componentImports)) {
    if (target.file === dep) return local
  }
  for (const [local, target] of Object.entries(node.namespaceImports)) {
    if (target === dep) return `* as ${local}`
  }
  return '<side effect>'
}
