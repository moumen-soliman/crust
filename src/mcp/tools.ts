import {
  buildFindings,
  buildSummary,
  causeBlastRadius,
  compareBuilds,
  explainRouteCause,
  listBuilds,
  routeDetail,
  routeHistory,
  type Session,
} from './answers.ts'

/**
 * The tool surface, described once and free of any protocol type.
 *
 * Keeping the catalogue transport-agnostic is what makes the MCP SDK an
 * implementation detail rather than a commitment: `server.ts` is the only file
 * that knows what MCP is, and the contract tests call these handlers directly
 * without standing a server up.
 *
 * Descriptions are written for a model choosing between tools, so each one says
 * what question it answers and, where it matters, what it will not do. A tool
 * whose description omits "never builds" invites a caller to expect that it
 * might.
 */

export interface ToolSpec {
  name: string
  title: string
  description: string
  /**
   * Declared per tool rather than stamped on in the transport, so the claim sits
   * next to the handler it describes and a test can hold every tool to it. A
   * client uses this to decide what to auto-approve; a tool that acquired a write
   * would have to change this line to keep lying, which is the point.
   */
  readOnly: true
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
  handler: (session: Session, input: Record<string, unknown>) => Promise<unknown>
}

const REF = {
  type: 'string',
  description:
    'A buildId, git sha, branch name or HEAD~n. Resolved exactly - never substituted with a nearby build. Defaults to the newest stored snapshot.',
} as const

const ROUTE = {
  type: 'string',
  description: 'A route, matched exactly on its URL pattern (`/blog/[slug]`), its trend id, or its source path. No fuzzy matching.',
} as const

export const TOOLS: ToolSpec[] = [
  {
    name: 'list_builds',
    title: 'List recorded builds',
    readOnly: true,
    description:
      'List the production-build snapshots recorded in this project\'s .perf/ store, newest first. Start here: every other tool takes a ref that this returns. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum builds to return (capped at 20).' } },
      additionalProperties: false,
    },
    handler: (session, input) => listBuilds(session, input as { limit?: number }),
  },
  {
    name: 'build_summary',
    title: 'Summarise one build',
    readOnly: true,
    description:
      'What this build is: its verdict against the latest comparable baseline, the routes that moved, shared root causes, heaviest routes, budget breaches and attribution coverage. The same values `crust analyze` printed. Read-only; never runs a build.',
    inputSchema: {
      type: 'object',
      properties: { ref: REF },
      additionalProperties: false,
    },
    handler: (session, input) => buildSummary(session, input as { ref?: string }),
  },
  {
    name: 'route_detail',
    title: 'Inspect one route',
    readOnly: true,
    description:
      'Everything recorded about a single route: rendering mode and why, first-load byte breakdown including unattributed bytes, heaviest dependencies and modules, client boundaries, barrel costs, layout chain and static shell.',
    inputSchema: {
      type: 'object',
      properties: { route: ROUTE, ref: REF },
      required: ['route'],
      additionalProperties: false,
    },
    handler: (session, input) => routeDetail(session, input as unknown as { route: string; ref?: string }),
  },
  {
    name: 'explain_route_cause',
    title: 'Explain why a route is dynamic',
    readOnly: true,
    description:
      'The full source chain behind a route\'s rendering mode: route to component to import hops to the call site that made it dynamic, each with its evidence level. Where the chain has a gap, the gap is returned rather than guessed across.',
    inputSchema: {
      type: 'object',
      properties: { route: ROUTE, ref: REF },
      required: ['route'],
      additionalProperties: false,
    },
    handler: (session, input) => explainRouteCause(session, input as unknown as { route: string; ref?: string }),
  },
  {
    name: 'compare_builds',
    title: 'Compare two builds',
    readOnly: true,
    description:
      'What changed between two recorded builds: the merge decision, the routes that regressed or improved, and the packages, client boundaries and barrels responsible. Equivalent to `crust diff <base> <head>`. Both sides must already be recorded - this never builds a ref.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { ...REF, description: `Baseline side. ${REF.description}` },
        head: { ...REF, description: `Head side. ${REF.description}` },
      },
      required: ['base'],
      additionalProperties: false,
    },
    handler: (session, input) => compareBuilds(session, input as unknown as { base: string; head?: string }),
  },
  {
    name: 'cause_blast_radius',
    title: 'Find every route a cause reaches',
    readOnly: true,
    description:
      'Which routes one package, `use client` boundary, barrel import or layout affects in a build, with what it costs each. Answers "if I fix this, what improves" before the work starts.',
    inputSchema: {
      type: 'object',
      properties: {
        cause: {
          type: 'string',
          description: 'A package name, a `use client` file path, a barrel file path, a layout path, or a sharedCauses key - exactly as another tool reported it.',
        },
        ref: REF,
      },
      required: ['cause'],
      additionalProperties: false,
    },
    handler: (session, input) => causeBlastRadius(session, input as unknown as { cause: string; ref?: string }),
  },
  {
    name: 'route_history',
    title: 'Trend one route over time',
    readOnly: true,
    description:
      'First-load bytes and shell ratio for one route across stored builds, oldest first, filtered to snapshots with the same schema, bundler and Next major. Answers whether a route has regressed before.',
    inputSchema: {
      type: 'object',
      properties: { route: ROUTE, ref: REF, limit: { type: 'number', description: 'Maximum snapshots to walk back (capped at 30).' } },
      required: ['route'],
      additionalProperties: false,
    },
    handler: (session, input) => routeHistory(session, input as unknown as { route: string; ref?: string; limit?: number }),
  },
  {
    name: 'build_findings',
    title: 'Rank what is worth fixing',
    readOnly: true,
    description:
      'Of everything in this build, what is worth an afternoon - ranked by crust\'s deterministic severity bands, each with the evidence and a concrete action. Not model-generated. Unrelated to the `crust findings` CLI command, which records reviewer agreement instead.',
    inputSchema: {
      type: 'object',
      properties: { ref: REF, limit: { type: 'number', description: 'Maximum findings to return (capped at 10).' } },
      additionalProperties: false,
    },
    handler: (session, input) => buildFindings(session, input as { ref?: string; limit?: number }),
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/**
 * Run a tool by name.
 *
 * An unknown name is an answer, not a thrown error: a model that mistyped a tool
 * gets the list back and retries, where a stack trace would end the attempt.
 */
export async function callTool(session: Session, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool) {
    return {
      ok: false,
      error: `No such tool "${name}".`,
      remedy: `Available tools: ${TOOLS.map((entry) => entry.name).join(', ')}.`,
    }
  }
  return tool.handler(session, input)
}
