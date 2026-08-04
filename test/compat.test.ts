import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeBuild } from '../src/analyze/analyze.ts'
import type { Bundler, RenderingMode } from '../src/adapters/types.ts'
import type { Snapshot } from '../src/store/snapshot.ts'

/**
 * Compatibility matrix (roadmap §10).
 *
 * crust reads artifacts whose shape is undocumented and moves on minor
 * releases, so the only defence is a real production build per supported
 * combination with its answers pinned. Each case pins the four things every
 * other feature is derived from: route classification, shell discovery, source
 * attribution, and cause relationships.
 *
 * Builds are gitignored and produced by CI (see .github/workflows/ci.yml); a
 * case skips rather than fails when its build is absent, so a contributor who
 * has built one fixture is not blocked by the others.
 */
interface FixtureCase {
  name: string
  cwd: string
  distDir: string
  bundler: Bundler
  nextMajor: number
  /**
   * Minimum minor, for a case whose subject only exists from one. A floor rather
   * than an exact pin so the canary job - which builds this fixture against
   * `next@canary` - reports a detector that stopped firing instead of failing on
   * the version number every time the minor moves.
   */
  nextMinorAtLeast?: number
  /** Rendering mode expected per route pattern. */
  routes: Record<string, RenderingMode | 'unknown'>
  /** Build-level navigation config this build must record, exactly. */
  navigation?: { partialPrefetching: boolean | 'unstable_eager'; instantValidation: string | null }
  /** Route pattern -> the whole segment config crust must record for it. */
  segmentConfig?: Record<string, Record<string, string | number | boolean>>
  /**
   * Route pattern -> substring of the warning that must name a segment export the
   * build declared and crust could not read. Absent from `segmentConfig` and
   * absent from here would mean the route was quietly reported as declaring
   * nothing.
   */
  unreadableConfig?: Record<string, string>
  /** Patterns whose build emitted a readable shell. */
  shells?: string[]
  /** Workspace-relative sources that must be attributed somewhere. */
  attributes?: string[]
  /** Route pattern -> the binding chain crust must produce for its cause. */
  chain?: { route: string; component: string; bindings: string[]; site: RegExp }
  /** A barrel that must be caught dragging modules into a route. */
  barrel?: { route: string; file: string; dragged: string[] }
  /** A root cause that must be reported once, with these routes attached. */
  sharedCause?: { kind: string; label: string; routes: string[]; introducedBy?: string }
}

const CASES: FixtureCase[] = [
  {
    name: 'next 16 · webpack · cache components',
    cwd: 'fixtures/basic',
    distDir: '.next-cc',
    bundler: 'webpack',
    nextMajor: 16,
    routes: {
      '/': 'STATIC',
      '/api/ping': 'ROUTE_HANDLER',
      '/dashboard': 'PARTIALLY_STATIC',
      '/docs/[...slug]': 'STATIC',
      '/files/[[...path]]': 'STATIC',
      '/products/[slug]': 'PARTIALLY_STATIC',
    },
    // Every page route, including both catch-all shapes: `generateStaticParams`
    // prerenders them, so a shell exists to read even for a pattern that never
    // appears literally in the output.
    shells: ['/', '/dashboard', '/docs/[...slug]', '/files/[[...path]]', '/products/[slug]'],
    attributes: ['fixtures/basic/components/Gallery.tsx'],
    chain: {
      route: '/products/[slug]',
      component: 'ProductGallery',
      bindings: ['ProductPage', 'ProductGallery', 'getProduct', 'fetchJson'],
      site: /lib\/http\.ts:\d+$/,
    },
    // `app/page.tsx` imports only `Hero` from the barrel; the client components
    // arrive anyway. This is the defect the tool exists to surface.
    barrel: {
      route: '/',
      file: 'fixtures/basic/components/index.ts',
      dragged: ['fixtures/basic/components/Counter.tsx', 'fixtures/basic/components/Gallery.tsx'],
    },
  },
  {
    name: 'next 16 · webpack · cache components off',
    cwd: 'fixtures/basic',
    distDir: '.next',
    bundler: 'webpack',
    nextMajor: 16,
    // The inverted rule set: without Cache Components a dynamic read opts the
    // whole route out instead of shrinking its shell.
    routes: {
      '/': 'STATIC',
      '/api/ping': 'ROUTE_HANDLER',
      '/dashboard': 'DYNAMIC',
      '/docs/[...slug]': 'STATIC',
      '/files/[[...path]]': 'STATIC',
      '/products/[slug]': 'DYNAMIC',
    },
  },
  {
    name: 'next 16 · turbopack',
    cwd: 'fixtures/basic',
    distDir: '.next-turbo',
    bundler: 'turbopack',
    nextMajor: 16,
    routes: {
      '/': 'STATIC',
      '/api/ping': 'ROUTE_HANDLER',
      '/dashboard': 'DYNAMIC',
      '/docs/[...slug]': 'STATIC',
      '/files/[[...path]]': 'STATIC',
      '/products/[slug]': 'DYNAMIC',
    },
    // Turbopack anchors source paths at the workspace root rather than the app,
    // which is the divergence that makes a second bundler worth building.
    attributes: ['fixtures/basic/components/Gallery.tsx'],
  },
  {
    // The declared navigation axis. Everything pinned here is something the build
    // stated outright; nothing in it is measured, because 16.3 emits no artifact
    // that distinguishes an instant route from a plain one.
    name: 'next 16.3 · webpack · instant navigations',
    cwd: 'fixtures/instant',
    distDir: '.next',
    bundler: 'webpack',
    nextMajor: 16,
    nextMinorAtLeast: 3,
    routes: {
      '/': 'STATIC',
      '/eager': 'STATIC',
      '/instant': 'STATIC',
      '/opaque': 'STATIC',
      '/section/nested': 'STATIC',
    },
    // `'manual-warning'` is not Next's default, so reading it back proves crust
    // reports what the build said rather than the default it would have guessed.
    navigation: { partialPrefetching: true, instantValidation: 'manual-warning' },
    segmentConfig: {
      '/': {},
      '/instant': { instant: true },
      '/eager': { prefetch: 'unstable_eager' },
      // Declared on the layout, recorded against the page that inherits it and
      // keyed by the file that set it - so the diff can blame the layout.
      '/section/nested': { 'fixtures/instant/app/section/layout.tsx:prefetch': 'force-disabled' },
      // The options-object form. Empty here, and named in `unreadableConfig`.
      '/opaque': {},
    },
    unreadableConfig: { '/opaque': 'route segment config `instant` is not a literal' },
  },
  {
    name: 'next 15 · webpack · legacy rule set',
    cwd: 'fixtures/legacy',
    distDir: '.next',
    bundler: 'webpack',
    nextMajor: 15,
    routes: {
      '/': 'STATIC',
      '/api/edge': 'ROUTE_HANDLER',
      '/isr': 'ISR',
      '/live': 'DYNAMIC',
    },
    chain: {
      route: '/live',
      component: 'LivePage',
      bindings: ['LivePage', 'readTheme'],
      site: /lib\/session\.ts:\d+$/,
    },
  },
  {
    name: 'next 16 · webpack · monorepo, aliases, workspace packages, barrels',
    cwd: 'fixtures/monorepo/apps/web',
    distDir: '.next-cc',
    bundler: 'webpack',
    nextMajor: 16,
    routes: { '/': 'STATIC', '/feed': 'PARTIALLY_STATIC' },
    // Resolved across a workspace package boundary and an `export *` barrel.
    attributes: [
      'fixtures/monorepo/packages/ui/src/Chart.tsx',
      'fixtures/monorepo/packages/icons/src/Sparkline.tsx',
    ],
    chain: {
      route: '/feed',
      component: 'FeedChart',
      bindings: ['Feed', 'FeedChart', 'loadPoints'],
      site: /lib\/points\.ts:\d+$/,
    },
    // One client component in a workspace package, reached by both routes, and
    // attributed to the package by its declared name rather than its path.
    sharedCause: {
      kind: 'client-boundary',
      label: '<Chart>',
      routes: ['/', '/feed'],
      introducedBy: '@fixture/ui',
    },
  },
]

const root = join(import.meta.dirname, '..')
const built = (fixture: FixtureCase): boolean =>
  existsSync(join(root, fixture.cwd, fixture.distDir, 'app-path-routes-manifest.json'))

for (const fixture of CASES) {
  describe.skipIf(!built(fixture))(`compatibility: ${fixture.name}`, () => {
    let snapshot: Snapshot

    const analyze = async (): Promise<Snapshot> => {
      snapshot ??= await analyzeBuild({
        cwd: join(root, fixture.cwd),
        distDir: fixture.distDir,
        toolVersion: 'test',
      })
      return snapshot
    }

    it('identifies the build', async () => {
      const result = await analyze()
      expect(result.bundler).toBe(fixture.bundler)
      expect(Number(result.nextVersion.split('.')[0])).toBe(fixture.nextMajor)
      if (fixture.nextMinorAtLeast !== undefined) {
        expect(Number(result.nextVersion.split('.')[1])).toBeGreaterThanOrEqual(fixture.nextMinorAtLeast)
      }
    })

    it('classifies every route', async () => {
      const result = await analyze()
      const modes = Object.fromEntries(result.routes.map((route) => [route.pattern, route.renderingMode]))
      expect(modes).toEqual(fixture.routes)
    })

    it('reports coverage it can stand behind', async () => {
      const result = await analyze()
      // Classification is the one dimension with no excuse: every route in the
      // table was either understood or explicitly refused.
      expect(result.coverage.routesClassified).toBe(result.coverage.routesTotal)
      expect(result.coverage.confidence).toBeGreaterThan(0)
      expect(result.coverage.confidence).toBeLessThanOrEqual(1)
    })

    if (fixture.navigation) {
      it('records the build-level navigation config the build resolved', async () => {
        const result = await analyze()
        expect(result.config?.partialPrefetching).toBe(fixture.navigation!.partialPrefetching)
        expect(result.config?.instantValidation).toBe(fixture.navigation!.instantValidation)
      })
    }

    if (fixture.segmentConfig) {
      it('records each route\'s navigation segment config, and invents none', async () => {
        const result = await analyze()
        for (const [pattern, expected] of Object.entries(fixture.segmentConfig!)) {
          const route = result.routes.find((r) => r.pattern === pattern)
          expect(route, `no route ${pattern}`).toBeDefined()
          // Whole-object equality on purpose: a route that gains a key it never
          // declared is the failure this pins, and a subset check would pass.
          expect(route?.config).toEqual(expected)
        }
      })
    }

    if (fixture.unreadableConfig) {
      it('says which segment exports it could not read, rather than reporting them unset', async () => {
        const result = await analyze()
        for (const [pattern, expected] of Object.entries(fixture.unreadableConfig!)) {
          const route = result.routes.find((r) => r.pattern === pattern)
          expect(route?.warnings.join(' '), `${pattern} recorded no unknown`).toContain(expected)
        }
      })
    }

    if (fixture.shells) {
      it('finds the shells the build emitted', async () => {
        const result = await analyze()
        const measured = result.routes
          .filter((route) => route.shell?.actual)
          .map((route) => route.pattern)
          .sort()
        expect(measured).toEqual([...fixture.shells!].sort())
      })
    }

    if (fixture.attributes) {
      it('attributes client bytes back to first-party source', async () => {
        const result = await analyze()
        const attributed = new Set(result.routes.flatMap((route) => Object.keys(route.modules)))
        for (const file of fixture.attributes!) expect([...attributed]).toContain(file)
      })
    }

    if (fixture.barrel) {
      it('charges the barrel for the modules the route never renders', async () => {
        const result = await analyze()
        const route = result.routes.find((r) => r.pattern === fixture.barrel!.route)
        const barrel = route?.barrels.find((b) => b.file === fixture.barrel!.file)

        expect(barrel, `no barrel cost for ${fixture.barrel!.file}`).toBeDefined()
        for (const file of fixture.barrel!.dragged) expect(barrel?.dragged).toContain(file)
        expect(barrel?.bytes).toBeGreaterThan(0)
      })
    }

    if (fixture.sharedCause) {
      it('reports the shared cause once, with every route it reaches', async () => {
        const result = await analyze()
        const cause = result.sharedCauses.find(
          (c) => c.kind === fixture.sharedCause!.kind && c.label === fixture.sharedCause!.label,
        )

        expect(cause, `no ${fixture.sharedCause!.kind} named ${fixture.sharedCause!.label}`).toBeDefined()
        expect(cause?.routes).toEqual(fixture.sharedCause!.routes)
        if (fixture.sharedCause!.introducedBy) {
          expect(cause?.introducedBy).toBe(fixture.sharedCause!.introducedBy)
        }
      })
    }

    if (fixture.chain) {
      it('produces the cause chain from route to call site', async () => {
        const result = await analyze()
        const route = result.routes.find((r) => r.pattern === fixture.chain!.route)
        const cause = route?.causes.find((c) => c.site && fixture.chain!.site.test(c.site))

        expect(cause, `no cause matching ${fixture.chain!.site} on ${fixture.chain!.route}`).toBeDefined()
        expect(cause?.component).toBe(fixture.chain!.component)
        expect(cause?.links.map((link) => link.binding)).toEqual(fixture.chain!.bindings)
        expect(cause?.unresolved).toBeNull()
      })
    }
  })
}

describe('compatibility matrix', () => {
  it('covers every combination the README claims support for', () => {
    // A guard against a case being deleted to make a failure go away.
    expect(CASES.map((c) => `${c.nextMajor}:${c.bundler}:${c.distDir}`)).toEqual([
      '16:webpack:.next-cc',
      '16:webpack:.next',
      '16:turbopack:.next-turbo',
      '16:webpack:.next',
      '15:webpack:.next',
      '16:webpack:.next-cc',
    ])
  })
})
