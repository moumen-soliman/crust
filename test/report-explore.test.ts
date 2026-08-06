import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { renderReportHtml } from '../src/report/render.ts'
import { route, snapshot } from './factories.ts'
import type { SharedCause } from '../src/store/snapshot.ts'

/**
 * The report's exploration controls run in a browser, so they are tested in one.
 *
 * Asserting on the markup instead would pass with the script deleted - which is
 * the actual failure mode for a feature whose entire value is what happens after
 * the page loads.
 */

const cause = (overrides: Partial<SharedCause> = {}): SharedCause => ({
  kind: 'client-boundary',
  key: 'packages/ui/src/Provider.tsx',
  label: '<RootProvider>',
  routes: ['/', '/feed'],
  bytesPerRoute: 86_016,
  bytesTotal: 172_032,
  component: 'RootProvider',
  introducedBy: '@repo/features',
  evidence: 'verified',
  ...overrides,
})

const FIXTURE = snapshot({
  routes: [
    route({
      id: 'app/page.tsx',
      pattern: '/',
      renderingMode: 'STATIC',
      firstLoadBytes: 90_000,
      layouts: ['app/layout.tsx'],
      modules: { 'components/Hero.tsx': 4000 },
    }),
    route({
      id: 'app/feed/page.tsx',
      pattern: '/feed',
      renderingMode: 'DYNAMIC',
      firstLoadBytes: 300_000,
      layouts: ['app/layout.tsx'],
      modules: { 'packages/ui/src/Chart.tsx': 9000 },
      unattributedBytes: 200_000,
    }),
    route({
      id: 'app/docs/page.tsx',
      pattern: '/docs',
      renderingMode: 'PARTIALLY_STATIC',
      firstLoadBytes: 100_000,
      layouts: ['app/docs/layout.tsx'],
      modules: {},
    }),
  ],
  sharedCauses: [cause(), cause({ kind: 'barrel', key: 'packages/ui/src/index.ts', label: 'barrel import packages/ui/src/index.ts', routes: ['/feed', '/docs'] })],
})

let browser: Browser
let page: Page

const visibleRoutes = () =>
  page.$$eval('tr.route:not(.hidden) code', (nodes) => nodes.map((n) => n.textContent ?? ''))

/**
 * Playwright is an optional peer dependency and its browsers are a separate
 * download, so a contributor who has not run `playwright install` skips this
 * file rather than watching it fail. CI installs chromium (see ci.yml) - if it
 * ever stops, these tests go quiet instead of red, which is the same trade the
 * fixture-backed suites already make.
 */
const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import('playwright')
    await (await chromium.launch()).close()
    return true
  } catch {
    return false
  }
})()

beforeAll(async () => {
  const { chromium } = await import('playwright')
  browser = await chromium.launch()
  page = await browser.newPage()
}, 60_000)

// A fresh document per test. Sharing one page makes every assertion depend on
// whatever the previous test left behind, so a single ordering mistake fails
// four tests and hides which one is actually broken.
beforeEach(async () => {
  await page.setContent(renderReportHtml(FIXTURE))
})

afterAll(async () => {
  await browser?.close()
})

// The table is sorted by first-load size, so this is display order, not the
// order the routes were declared in.
const ALL = ['/feed', '/docs', '/']

describe.skipIf(!chromiumAvailable)('exploratory report', () => {
  it('shows every route before anything is filtered', async () => {
    expect(await visibleRoutes()).toEqual(ALL)
    expect(await page.textContent('#crust-count')).toBe('3 routes')
  })

  it('filters to a rendering mode', async () => {
    await page.click('[data-crust-filter="dynamic"]')
    expect(await visibleRoutes()).toEqual(['/feed'])
    expect(await page.textContent('#crust-count')).toContain('1 of 3 routes')
  })

  it('filters to routes carrying unattributed bytes', async () => {
    await page.click('[data-crust-filter="unattributed"]')
    expect(await visibleRoutes()).toEqual(['/feed'])
  })

  it('searches source files, not only route patterns', async () => {
    // The point of the search box: nobody needs help finding `/feed` in a list
    // of three, they need to find which route ships `Chart.tsx`.
    await page.fill('#crust-search', 'chart.tsx')
    expect(await visibleRoutes()).toEqual(['/feed'])
  })

  it('narrows to exactly the routes a shared cause reaches, and back again', async () => {
    await page.click('.cause >> nth=0')
    expect(await visibleRoutes()).toEqual(['/feed', '/'])
    expect(await page.textContent('#crust-count')).toContain('shared cause')

    await page.click('.cause >> nth=0')
    expect(await visibleRoutes()).toEqual(ALL)
  })

  it('groups by layout with a heading per group', async () => {
    await page.click('[data-crust-group="layout"]')
    const headings = await page.$$eval('tr.grouphead td', (nodes) => nodes.map((n) => n.textContent ?? ''))
    expect(headings).toEqual(['app/docs/layout.tsx', 'app/layout.tsx'])

    await page.click('[data-crust-group="none"]')
    expect(await page.$$('tr.grouphead')).toHaveLength(0)
  })

  it('does not print a group heading over an empty group', async () => {
    await page.click('[data-crust-group="layout"]')
    await page.click('[data-crust-filter="dynamic"]')
    const headings = await page.$$eval('tr.grouphead td', (nodes) => nodes.map((n) => n.textContent ?? ''))
    expect(headings).toEqual(['app/layout.tsx'])
  })

  it('offers a PR-ready explanation naming cost, reach and owner', async () => {
    const text = await page.getAttribute('.cause >> nth=0 >> .copy', 'data-crust-copy')
    expect(text).toContain('<RootProvider>')
    expect(text).toContain('84.0 kB')
    expect(text).toContain('2 routes')
    expect(text).toContain('@repo/features')
    expect(text).toContain('verified')
  })

  it('still expands a route to its detail row', async () => {
    await page.click('tr.route >> nth=0 >> td >> nth=0')
    expect(await page.$$('tr.detail.open')).toHaveLength(1)
  })
})

/**
 * The controls only work if someone finds them.
 *
 * The route table's search sits under everything the report says first - the
 * verdict, the findings, the shared causes - so on a laptop it opens below the
 * fold, and a report with no visible search reads as a report that has none.
 *
 * Racing those sections against a text input for vertical space is the wrong
 * fix: it starves the evidence, and it breaks again the next time the report
 * learns to say something. The jump bar is the guarantee instead, so that is what
 * these assert - reachable in one click, from the first screen, at any height.
 */
describe.skipIf(!chromiumAvailable)('finding the controls at all', () => {
  const many = snapshot({
    routes: FIXTURE.routes,
    sharedCauses: Array.from({ length: 12 }, (_, i) =>
      cause({ key: `packages/ui/src/C${i}.tsx`, label: `<Cause${i}>`, routes: ['/', '/feed'] }),
    ),
  })

  it.each([900, 800, 700, 600])('puts the jump bar on the first screen at %ipx tall', async (height) => {
    const laptop = await browser.newPage({ viewport: { width: 1280, height } })
    try {
      await laptop.setContent(renderReportHtml(many))
      const box = await laptop.locator('.jump').boundingBox()
      expect(box, 'the jump bar did not render').not.toBeNull()
      expect(box!.y).toBeLessThan(height)
    } finally {
      await laptop.close()
    }
  })

  it('takes you to the search box and leaves you typing in it', async () => {
    await page.setContent(renderReportHtml(many))
    await page.click('#crust-jump-search')

    // Focused, not merely scrolled into view: "I could not find the search" is
    // not fixed by putting it on screen and making them click again.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('crust-search')

    await page.keyboard.type('chart.tsx')
    expect(await visibleRoutes()).toEqual(['/feed'])
  })

  it('names only the sections the report actually has', async () => {
    await page.setContent(renderReportHtml(snapshot({ routes: FIXTURE.routes, sharedCauses: [] })))
    expect(await page.$$('.jump a[href="#crust-causes"]')).toHaveLength(0)
    expect(await page.$$('.jump a[href="#crust-routes"]')).toHaveLength(1)
  })

  it('folds the tail of the cause list rather than dropping it', async () => {
    await page.setContent(renderReportHtml(many))

    // Three above the fold, the rest one disclosure away - and still all there.
    expect(await page.$$('.causes.shared:not(.fold .causes) > .cause')).toHaveLength(3)
    expect(await page.textContent('.fold > summary')).toContain('9 more shared causes')

    await page.click('.fold > summary')
    expect(await page.$$('.cause')).toHaveLength(12)
  })

  it('leaves a folded cause working as a filter once it is revealed', async () => {
    await page.setContent(renderReportHtml(many))
    await page.click('.fold > summary')
    await page.click('.fold .cause >> nth=0')

    expect(await visibleRoutes()).toEqual(['/feed', '/'])
  })

  it('shows no disclosure when every cause already fits', async () => {
    await page.setContent(renderReportHtml(FIXTURE))
    expect(await page.$$('.causes.shared ~ .fold')).toHaveLength(0)
  })
})

/**
 * `crust analyze` prints the top three findings and then "+ N more in `crust
 * report`". Until this section existed the report kept none of that promise, so
 * the rest of the list was reachable from nowhere.
 */
describe.skipIf(!chromiumAvailable)('fix first', () => {
  it('renders the findings the terminal defers here, worst first', async () => {
    await page.setContent(renderReportHtml(FIXTURE))

    const headlines = await page.$$eval('.finding .finding-head b', (nodes) => nodes.map((n) => n.textContent ?? ''))
    expect(headlines.length).toBeGreaterThan(0)
    // /feed is DYNAMIC and 300 kB; the dynamic band outranks the size band.
    expect(headlines[0]).toContain('renders on every request')
  })

  it('gives every finding an action, because a finding without one is noise', async () => {
    await page.setContent(renderReportHtml(FIXTURE))
    const shown = await page.$$('.finding')
    const actions = await page.$$('.finding .action')
    expect(actions).toHaveLength(shown.length)
    for (const action of actions) expect((await action.textContent())?.trim().length).toBeGreaterThan(10)
  })

  it('keeps the whole list, folding past the three the terminal already showed', async () => {
    // Six dynamic routes - one finding each, so the tail is real.
    const busy = snapshot({
      routes: Array.from({ length: 6 }, (_, i) =>
        route({ id: `app/r${i}/page.tsx`, pattern: `/r${i}`, renderingMode: 'DYNAMIC', dynamicReasons: ['cookies() at a.ts:1'] }),
      ),
    })
    await page.setContent(renderReportHtml(busy))

    expect(await page.$$('.findings:not(.fold .findings) > .finding')).toHaveLength(3)
    const fold = page.locator('.fold').first()
    expect(await fold.locator('summary').textContent()).toContain('3 more findings')

    await fold.locator('summary').click()
    expect(await page.$$('.finding')).toHaveLength(6)
  })

  it('says nothing at all when there is nothing to fix', async () => {
    const clean = snapshot({ routes: [route({ renderingMode: 'STATIC', firstLoadBytes: 1_000, shell: null })] })
    await page.setContent(renderReportHtml(clean))

    expect(await page.$$('.findings')).toHaveLength(0)
    expect(await page.$$('.jump a[href="#crust-fix"]')).toHaveLength(0)
  })
})
