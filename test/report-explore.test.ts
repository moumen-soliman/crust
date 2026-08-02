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
