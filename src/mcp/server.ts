import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { openSession } from './answers.ts'
import { callTool, TOOLS } from './tools.ts'

/**
 * The only file in crust that knows what MCP is.
 *
 * Everything the agent can actually ask for lives in `tools.ts` and `answers.ts`,
 * neither of which imports a protocol type. That seam is deliberate: the SDK
 * brings an HTTP server, an OAuth stack and a schema validator along for what is,
 * over stdio, a JSON-RPC read loop. If that install cost stops being worth it,
 * replacing this file is the entire migration - the tool surface is the contract,
 * and it does not mention the transport.
 */

export interface ServeOptions {
  cwd: string
  version: string
}

/**
 * On stdio, stdout *is* the protocol.
 *
 * One stray `console.log` from anywhere in the process interleaves with a
 * JSON-RPC frame and the client drops the connection with a parse error that
 * names neither the writer nor the line. crust's own code paths here do not
 * print, but a dependency's deprecation notice is not crust's to prevent, so the
 * channel is taken away from `console` rather than defended by convention.
 */
function protectStdout(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.warn = toStderr
  console.debug = toStderr
}

export async function serveMcp(options: ServeOptions): Promise<void> {
  protectStdout()

  const session = await openSession(options.cwd)

  const server = new Server(
    { name: 'crust', version: options.version },
    {
      capabilities: { tools: {} },
      instructions:
        'crust answers questions about Next.js production builds from snapshots recorded in this project\'s .perf/ store. ' +
        'Every tool is a read-only query: none of them builds, installs, or writes a snapshot, so answers only cover commits someone has already run `crust analyze` on. ' +
        'Call list_builds first to see what is recorded. ' +
        'Answers carry an attribution coverage block - cite it, and treat a short finding list under weak coverage as "not measured" rather than "nothing wrong". ' +
        'Every answer names the buildId it came from; quote it so a human can re-derive the claim with `crust diff`.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Taken from the tool's own declaration rather than asserted here, so the
      // hint a client auto-approves on cannot drift from the handler.
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    let result: unknown
    try {
      result = await callTool(session, name, (args ?? {}) as Record<string, unknown>)
    } catch (error) {
      // A thrown error reaches the model as "the tool broke". Turning it into the
      // same refusal shape every other failure uses keeps the next call informed
      // rather than blind.
      result = {
        ok: false,
        error: `crust could not answer: ${error instanceof Error ? error.message : String(error)}`,
        remedy: 'Check that this project has a .perf/ store (`crust list`). If the snapshot is from an older crust, it may predate a schema bump.',
      }
    }

    const failed = typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      ...(failed ? { isError: true } : {}),
    }
  })

  await server.connect(new StdioServerTransport())

  // The transport owns the process from here: it resolves on connect and keeps
  // reading stdin until the client closes it.
  process.stderr.write(`crust mcp: serving ${TOOLS.length} read-only tools over stdio from ${session.root}/.perf\n`)
}
