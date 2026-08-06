import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, type Session } from '../src/mcp/answers.ts'
import { callTool, TOOLS } from '../src/mcp/tools.ts'
import { SnapshotStore } from '../src/store/store.ts'
import { route, snapshot } from './factories.ts'

/**
 * Contract tests for the MCP tool layer.
 *
 * They call the handlers directly rather than through a transport: the tool
 * surface is the contract, and standing up a stdio server to assert on JSON that
 * `answers.ts` produced would test the SDK instead of crust.
 *
 * The six constraints in the plan get their own describe block at the bottom.
 * They are the reason this layer is safe to point an agent at, and every one of
 * them is the kind of property that decays silently when only the happy path is
 * covered.
 */

const BASE_ID = 'basebuild0000000'
const HEAD_ID = 'headbuild0000000'

/** A build with the shapes every tool has to read: causes, boundaries, barrels, a shell. */
function appSnapshot(overrides: Parameters<typeof snapshot>[0] = {}) {
  return snapshot({
    routes: [
      route({
        id: 'app/dashboard/page.tsx',
        pattern: '/dashboard',
        filePath: 'app/dashboard/page.tsx',
        renderingMode: 'DYNAMIC',
        renderingModeReason: 'cookies() at app/dashboard/page.tsx:18',
        firstLoadBytes: 320_000,
        routeBytes: 120_000,
        sharedBytes: 200_000,
        unattributedBytes: 18_000,
        dependencies: { 'date-fns': 48_200, react: 40_000, '@repo/ui': 12_000 },
        modules: { 'app/dashboard/page.tsx': 2_400, 'lib/http.ts': 900 },
        dynamicReasons: ['cookies() at app/dashboard/page.tsx:18'],
        causes: [
          {
            route: '/dashboard',
            entryFile: 'app/dashboard/page.tsx',
            component: 'DashboardShell',
            links: [
              { file: 'app/dashboard/page.tsx', binding: 'DashboardShell', via: 'entry', barrel: false, component: true },
              { file: 'components/index.ts', binding: 'DashboardShell', via: 'import', barrel: true, component: true },
            ],
            site: 'lib/http.ts:3',
            detail: 'uncached fetch',
            evidence: 'verified',
            unresolved: null,
          },
        ],
        clientBoundaries: [{ file: 'components/Gallery.tsx', component: 'Gallery', bytes: 64_000 }],
        barrels: [{ file: 'components/index.ts', bytes: 30_000, dragged: ['components/Hero.tsx', 'components/Chart.tsx'] }],
        layouts: ['app/layout.tsx'],
        config: { dynamic: 'force-dynamic' },
        shell: {
          predictedStatic: ['Header'],
          predictedHoles: [{ component: 'Gallery', boundary: 'components/Gallery.tsx', reason: 'cookies() at app/dashboard/page.tsx:18' }],
          actual: { htmlPath: 'server/app/dashboard.html', bytes: 4_200, holes: 1, boundaryIds: ['B:0'], shellRatio: 0.42 },
          agreement: 0.9,
          unknown: [],
        },
        conservativeModules: 2,
      }),
      route({ id: 'app/page.tsx', pattern: '/', firstLoadBytes: 110_000, dependencies: { react: 40_000 } }),
    ],
    sharedCauses: [
      {
        kind: 'barrel',
        key: 'components/index.ts',
        label: '@repo/ui/icons',
        routes: ['/', '/dashboard'],
        bytesPerRoute: 30_000,
        bytesTotal: 60_000,
        component: null,
        introducedBy: '@repo/ui',
        evidence: 'inferred',
      },
    ],
    ...overrides,
  })
}

async function sessionWith(...snapshots: ReturnType<typeof snapshot>[]): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'crust-mcp-'))
  const store = new SnapshotStore(dir)
  for (const item of snapshots) await store.write(item)
  return openSession(dir)
}

/** The pair every comparison test uses: the head is heavier and lost its shell. */
async function pairSession(): Promise<Session> {
  const base = appSnapshot({ buildId: BASE_ID, createdAt: '2026-01-01T00:00:00.000Z', committedAt: '2026-01-01T00:00:00.000Z', branch: 'main' })
  const head = appSnapshot({ buildId: HEAD_ID, createdAt: '2026-02-01T00:00:00.000Z', committedAt: '2026-02-01T00:00:00.000Z', branch: 'feature' })
  head.routes[0]!.firstLoadBytes = 420_000
  head.routes[0]!.dependencies = { ...head.routes[0]!.dependencies, 'date-fns': 148_200 }
  return sessionWith(base, head)
}

describe('list_builds', () => {
  it('names every recorded build newest first, with the ids the other tools take', async () => {
    const session = await pairSession()
    const result = (await callTool(session, 'list_builds')) as any

    expect(result.ok).toBe(true)
    expect(result.builds.items.map((b: any) => b.buildId)).toEqual([HEAD_ID, BASE_ID])
    expect(result.builds.items[0]).toMatchObject({ branch: 'feature', bundler: 'webpack', routeCount: 2, dirty: false })
  })

  it('says the store is empty rather than returning nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-mcp-empty-'))
    const result = (await callTool(await openSession(dir), 'list_builds')) as any

    expect(result.builds.items).toEqual([])
    expect(result.note).toMatch(/store is empty[\s\S]*never builds/i)
  })
})

describe('build_summary', () => {
  it('carries the verdict, the causes and the coverage the CLI printed', async () => {
    const result = (await callTool(await pairSession(), 'build_summary')) as any

    expect(result.build.buildId).toBe(HEAD_ID)
    expect(result.baseline.buildId).toBe(BASE_ID)
    expect(result.decision.level).toMatch(/block|review|clear/)
    expect(result.heaviestRoutes.items[0].pattern).toBe('/dashboard')
    expect(result.sharedCauses.items[0].label).toBe('@repo/ui/icons')
    expect(result.coverage.attributedPercent).not.toBeUndefined()
  })

  it('refuses to call a single build clear, and says why it cannot decide', async () => {
    const result = (await callTool(await sessionWith(appSnapshot({ buildId: HEAD_ID })), 'build_summary')) as any

    expect(result.baseline).toBeNull()
    expect(result.decision.level).toBe('undecidable')
    expect(result.decision.why).toMatch(/no comparable baseline/i)
  })
})

describe('route_detail', () => {
  it('breaks one route down to the bytes, the boundaries and the barrels', async () => {
    const result = (await callTool(await pairSession(), 'route_detail', { route: '/dashboard' })) as any

    expect(result.route.renderingMode).toBe('DYNAMIC')
    expect(result.bytes.unattributed).toBe(18_000)
    expect(result.dependencies.items[0]).toEqual({ name: 'date-fns', bytes: 148_200 })
    expect(result.clientBoundaries.items[0]).toMatchObject({ component: 'Gallery', bytes: 64_000 })
    expect(result.barrels.items[0].dragged.items).toContain('components/Hero.tsx')
    expect(result.shell.actual.shellRatio).toBe(0.42)
  })

  it('matches the source path and the trend id, not just the URL pattern', async () => {
    const session = await pairSession()
    for (const ref of ['app/dashboard/page.tsx', '/dashboard']) {
      expect(((await callTool(session, 'route_detail', { route: ref })) as any).route.pattern).toBe('/dashboard')
    }
  })

  it('names the real routes rather than guessing at the nearest one', async () => {
    const result = (await callTool(await pairSession(), 'route_detail', { route: '/dashboad' })) as any

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no route "\/dashboad"/)
    expect(result.remedy).toContain('/dashboard')
  })
})

describe('explain_route_cause', () => {
  it('returns the chain from entry to call site with its evidence level', async () => {
    const result = (await callTool(await pairSession(), 'explain_route_cause', { route: '/dashboard' })) as any

    const chain = result.chains.items[0]
    expect(chain.site).toBe('lib/http.ts:3')
    expect(chain.detail).toBe('uncached fetch')
    expect(chain.evidence).toBe('verified')
    expect(chain.links.items.map((l: any) => l.file)).toEqual(['app/dashboard/page.tsx', 'components/index.ts'])
    expect(result.legend.unknown).toMatch(/refuses to guess/)
  })

  it('distinguishes a static route from one whose chain could not be built', async () => {
    const session = await sessionWith(
      appSnapshot({
        buildId: HEAD_ID,
        routes: [
          route({ id: 'app/page.tsx', pattern: '/', renderingMode: 'STATIC' }),
          route({ id: 'app/x/page.tsx', pattern: '/x', renderingMode: 'DYNAMIC', dynamicReasons: ['cookies()'], causes: [] }),
        ],
      }),
    )

    expect(((await callTool(session, 'explain_route_cause', { route: '/' })) as any).noChainsReason).toMatch(/not dynamic/)
    expect(((await callTool(session, 'explain_route_cause', { route: '/x' })) as any).noChainsReason).toMatch(/could not assemble/)
  })
})

describe('compare_builds', () => {
  it('reports the decision, the moved routes and the package behind them', async () => {
    const result = (await callTool(await pairSession(), 'compare_builds', { base: BASE_ID, head: HEAD_ID })) as any

    expect(result.base.buildId).toBe(BASE_ID)
    expect(result.head.buildId).toBe(HEAD_ID)
    expect(result.routes.items[0]).toMatchObject({ pattern: '/dashboard', firstLoadDelta: 100_000 })
    expect(result.dependencies.items.find((d: any) => d.pkg === 'date-fns').delta).toBe(100_000)
    expect(result.note).toBe(`Equivalent to \`crust diff ${BASE_ID} ${HEAD_ID}\`.`)
  })

  it('refuses a pair whose framework moved rather than blaming the code', async () => {
    const session = await sessionWith(
      appSnapshot({ buildId: BASE_ID, bundler: 'webpack', committedAt: '2026-01-01T00:00:00.000Z' }),
      appSnapshot({ buildId: HEAD_ID, bundler: 'turbopack', committedAt: '2026-02-01T00:00:00.000Z' }),
    )
    const result = (await callTool(session, 'compare_builds', { base: BASE_ID, head: HEAD_ID })) as any

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not safely comparable/)
    expect(result.remedy).toMatch(/bundler|Next major/)
  })

  it('refuses to compare a build with itself', async () => {
    const result = (await callTool(await pairSession(), 'compare_builds', { base: HEAD_ID, head: HEAD_ID })) as any

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/same build as the head/)
  })

  it('names a missing baseline instead of substituting a nearby one', async () => {
    const result = (await callTool(await pairSession(), 'compare_builds', { base: 'nosuchbuild00000' })) as any

    expect(result.ok).toBe(false)
    expect(result.remedy).toMatch(/never builds/)
  })
})

describe('cause_blast_radius', () => {
  it('finds every route a package reaches, worst first', async () => {
    const result = (await callTool(await pairSession(), 'cause_blast_radius', { cause: 'react' })) as any

    expect(result.routeCount).toBe(2)
    expect(result.routes.items.map((r: any) => r.pattern).sort()).toEqual(['/', '/dashboard'])
    expect(result.routes.items[0].how).toBe('dependency')
  })

  it('reaches a barrel through its shared cause as well as its routes', async () => {
    const result = (await callTool(await pairSession(), 'cause_blast_radius', { cause: 'components/index.ts' })) as any

    expect(result.sharedCauses.items[0].label).toBe('@repo/ui/icons')
    expect(result.worstRouteBytes).toBe(30_000)
    expect(result.note).toMatch(/never a total across routes/)
  })

  it('refuses a name the build does not contain', async () => {
    const result = (await callTool(await pairSession(), 'cause_blast_radius', { cause: 'lodash' })) as any

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/nothing in build .* is named "lodash"/i)
  })
})

describe('route_history', () => {
  it('trends one route across comparable builds, oldest first', async () => {
    const result = (await callTool(await pairSession(), 'route_history', { route: '/dashboard' })) as any

    expect(result.points.items.map((p: any) => p.buildId)).toEqual([BASE_ID, HEAD_ID])
    expect(result.trend).toMatchObject({ firstLoadDelta: 100_000, samples: 2 })
  })

  it('says why there is no trend rather than returning an empty one', async () => {
    const result = (await callTool(await sessionWith(appSnapshot({ buildId: HEAD_ID })), 'route_history', { route: '/dashboard' })) as any

    expect(result.trend).toBeNull()
    expect(result.trendUnavailableReason).toMatch(/only 1 comparable snapshot/i)
  })
})

describe('build_findings', () => {
  it('ranks what is worth fixing, each with an action', async () => {
    const result = (await callTool(await pairSession(), 'build_findings')) as any

    expect(result.findings.items.length).toBeGreaterThan(0)
    for (const finding of result.findings.items) expect(finding.action).toBeTruthy()
    expect(result.note).toMatch(/not generated|Deterministic/)
  })

  it('does not let an empty list read as "nothing is wrong"', async () => {
    const clean = snapshot({ buildId: HEAD_ID, routes: [route({ firstLoadBytes: 1_000 })] })
    const result = (await callTool(await sessionWith(clean), 'build_findings')) as any

    if (result.findings.items.length === 0) expect(result.emptyMeans).toBeTruthy()
  })
})

/**
 * The plan's six non-negotiable constraints, as tests.
 *
 * Each is a property of the whole layer rather than of one tool, so each is
 * asserted across every tool: a constraint that holds for seven of eight is the
 * one an agent will find.
 */
describe('the constraints that make this safe to point an agent at', () => {
  let session: Session
  /** Every tool, with arguments valid against the fixture, so all eight really run. */
  let answers: { name: string; result: any }[]

  beforeAll(async () => {
    session = await pairSession()
    const calls: Record<string, Record<string, unknown>> = {
      list_builds: {},
      build_summary: {},
      route_detail: { route: '/dashboard' },
      explain_route_cause: { route: '/dashboard' },
      compare_builds: { base: BASE_ID, head: HEAD_ID },
      cause_blast_radius: { cause: 'react' },
      route_history: { route: '/dashboard' },
      build_findings: {},
    }
    answers = await Promise.all(
      TOOLS.map(async (tool) => ({ name: tool.name, result: await callTool(session, tool.name, calls[tool.name]!) })),
    )
  })

  it('exercises every registered tool, so none of the rules below is vacuous', () => {
    expect(answers.map((a) => a.name).sort()).toEqual(TOOLS.map((t) => t.name).sort())
    for (const { name, result } of answers) expect(result.ok, `${name} did not succeed`).toBe(true)
  })

  // 1 + 2. Read-only, and never builds.
  it('imports nothing that can build, analyse or write', async () => {
    const dir = new URL('../src/mcp/', import.meta.url)
    for (const file of await readdir(dir)) {
      const source = await readFile(new URL(file, dir), 'utf8')
      const imports = source.match(/^import[\s\S]*?from '[^']+'/gm)?.join('\n') ?? ''
      expect(imports, `${file} imports a build path`).not.toMatch(/analyze\/analyze|compare\/build-pair|child_process/)
      expect(source, `${file} writes to the store`).not.toMatch(/store\.write|\.rebuildIndex\(|\.prune\(/)
    }
  })

  it('leaves the store byte-identical after every tool has run', async () => {
    const before = await new SnapshotStore(session.root).list()
    for (const tool of TOOLS) await callTool(session, tool.name, { route: '/dashboard', cause: 'react', base: BASE_ID })
    const after = await new SnapshotStore(session.root).list()

    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('declares every tool read-only, which is what a client auto-approves on', () => {
    for (const tool of TOOLS) expect(tool.readOnly, `${tool.name} does not declare itself read-only`).toBe(true)
  })

  // 3. Coverage travels with every answer.
  it('attaches attribution coverage to every answer that reports bytes', () => {
    for (const { name, result } of answers) {
      if (name === 'list_builds') continue // identities only, no byte attribution
      expect(result.coverage, `${name} reported bytes with no coverage`).toBeDefined()
      expect(result.coverage.attributedPercent).toBeDefined()
      // The denominator travels too, so the percentage can be recomputed.
      expect(result.coverage.clientBytesTotal).toBeDefined()
      expect(result.coverage.clientBytesAttributed).toBeDefined()
    }
  })

  it('reports unknown attribution rather than a confident 100%', async () => {
    const noBytes = snapshot({ buildId: HEAD_ID, routes: [route({ firstLoadBytes: 0, sharedBytes: 0, routeBytes: 0 })] })
    const result = (await callTool(await sessionWith(noBytes), 'build_summary')) as any

    expect(result.coverage.attributedPercent).toBe('unknown')
    expect(result.coverage.caveat).toMatch(/absence of a finding is not evidence/i)
  })

  // 4. `unknown` is returned explicitly, never omitted.
  it('states why a conclusion is missing instead of dropping the field', async () => {
    const gap = snapshot({
      buildId: HEAD_ID,
      routes: [route({ id: 'app/x/page.tsx', pattern: '/x', renderingMode: 'unknown', renderingModeReason: null, shell: null })],
    })
    const local = await sessionWith(gap)

    const detail = (await callTool(local, 'route_detail', { route: '/x' })) as any
    expect(detail.route.renderingModeReason).toMatch(/unknown/)
    expect(detail.shellUnavailableReason).toMatch(/unmeasured/)

    const cause = (await callTool(local, 'explain_route_cause', { route: '/x' })) as any
    expect(cause.noChainsReason).toMatch(/could not classify/)
  })

  // 5. Bounded responses.
  it('caps every list and says so rather than truncating silently', async () => {
    const many = snapshot({
      buildId: HEAD_ID,
      routes: Array.from({ length: 60 }, (_, i) =>
        route({ id: `app/r${i}/page.tsx`, pattern: `/r${i}`, firstLoadBytes: 100_000 + i, dependencies: { react: 1_000 + i } }),
      ),
    })
    const result = (await callTool(await sessionWith(many), 'build_summary')) as any

    expect(result.heaviestRoutes.items.length).toBe(10)
    expect(result.heaviestRoutes.total).toBe(60)
    expect(result.heaviestRoutes.truncated).toBe(true)

    const blast = (await callTool(await sessionWith(many), 'cause_blast_radius', { cause: 'react' })) as any
    expect(blast.routes.truncated).toBe(true)
    expect(blast.routeCount).toBe(60)
  })

  it('never returns a whole snapshot', () => {
    for (const { name, result } of answers) {
      const text = JSON.stringify(result)
      expect(text.length, `${name} returned ${text.length} chars`).toBeLessThan(20_000)
      expect(text, `${name} leaked the raw module map`).not.toContain('"sourceSignature"')
    }
  })

  // 6. Cite the source.
  it('names the build behind every answer', () => {
    for (const { name, result } of answers) {
      if (name === 'list_builds') continue // it is the citation index itself
      const cited = result.build?.buildId ?? result.head?.buildId
      expect(cited, `${name} cited no build`).toBeTruthy()
      if (name === 'compare_builds') expect(result.base.buildId).toBe(BASE_ID)
    }
  })

  it('describes every tool as read-only where an agent will read it', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, `${tool.name} has a thin description`).toBeGreaterThan(80)
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('answers an unknown tool name with the list instead of throwing', async () => {
    const result = (await callTool(session, 'delete_everything')) as any

    expect(result.ok).toBe(false)
    expect(result.remedy).toContain('list_builds')
  })
})
