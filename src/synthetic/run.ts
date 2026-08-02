import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, hostname } from 'node:os'
import { join } from 'node:path'
import { envFingerprint, newRunId, type RunEnv } from '../core/build-id.ts'

/**
 * Synthetic measurement harness (plan §8, Phase 7).
 *
 * The rules that make the numbers comparable:
 *  - fixed route list, fixed CPU and network throttle — pinned into the run's
 *    env fingerprint, and runs with different fingerprints must never be merged
 *    into one trend line;
 *  - N iterations with the first discarded (cold start warms caches, JIT and
 *    the server) and the median reported — means are hostage to one GC pause;
 *  - the widget and collector stay OFF during synthetic runs (R7).
 *
 * Playwright is a peer, resolved at call time: it is a heavy dependency that
 * only synthetic runs need, and requiring it for everyone would put a browser
 * download in every install.
 */

export interface SyntheticOptions {
  baseUrl: string
  routes: string[]
  iterations?: number
  cpuThrottle?: number
  /** Simulated network, applied via CDP emulation. */
  network?: 'fast-3g' | 'slow-3g' | 'none'
  outDir?: string
}

export interface RouteMeasurement {
  route: string
  samples: PageSample[]
  median: PageSample
}

export interface PageSample {
  ttfb: number
  fcp: number
  lcp: number
  domContentLoaded: number
  load: number
  transferBytes: number
}

const NETWORK_PROFILES = {
  'fast-3g': { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  'slow-3g': { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
} as const

export async function runSynthetic(options: SyntheticOptions): Promise<{ runId: string; results: RouteMeasurement[]; outPath: string }> {
  const iterations = Math.max(2, options.iterations ?? 5)
  const cpuThrottle = options.cpuThrottle ?? 4
  const network = options.network ?? 'fast-3g'

  let chromium: typeof import('playwright')['chromium']
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error(
      'crust synthetic needs Playwright: `pnpm add -D playwright && pnpm exec playwright install chromium`. ' +
        'It is a peer, not a dependency, so ordinary installs never download a browser.',
    )
  }

  const browser = await chromium.launch()
  const results: RouteMeasurement[] = []

  try {
    for (const route of options.routes) {
      const samples: PageSample[] = []

      for (let i = 0; i < iterations; i++) {
        const context = await browser.newContext()
        const page = await context.newPage()
        const session = await context.newCDPSession(page)

        await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
        if (network !== 'none') {
          await session.send('Network.enable')
          await session.send('Network.emulateNetworkConditions', { offline: false, ...NETWORK_PROFILES[network] })
        }

        // LCP has to be observed, not queried. `getEntriesByType` after load
        // returns nothing on a page that never registered an observer, which is
        // why an unpatched harness reports lcp 0 for every route. The observer
        // has to exist before the first paint, so it goes in an init script.
        await page.addInitScript(() => {
          const w = window as typeof window & { __crustLcp?: number }
          w.__crustLcp = 0
          try {
            new PerformanceObserver((list) => {
              const entries = list.getEntries()
              const last = entries[entries.length - 1]
              if (last) w.__crustLcp = last.startTime
            }).observe({ type: 'largest-contentful-paint', buffered: true })
          } catch {
            // Entry type unsupported; LCP stays 0 and is reported as such.
          }
        })

        await page.goto(new URL(route, options.baseUrl).href, { waitUntil: 'load' })
        // LCP keeps updating until the largest element settles; a short quiet
        // period after load catches late hero images without waiting on idle.
        await page.waitForTimeout(500)
        const sample = await page.evaluate(readPageSample)
        await context.close()

        // The first iteration is the cold start — server compile caches, CDN
        // misses, JIT warmup. It measures the deployment's morning, not the code.
        if (i > 0) samples.push(sample)
      }

      results.push({ route, samples, median: medianSample(samples) })
    }
  } finally {
    await browser.close()
  }

  const runId = newRunId()
  const env: RunEnv = {
    machine: hostname(),
    cpuCount: cpus().length,
    throttle: `${cpuThrottle}x`,
    network,
    coldStart: false,
    browserVersion: browser.version(),
  }

  const outDir = join(options.outDir ?? '.perf', 'runs', runId)
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, 'meta.json'),
    JSON.stringify({ runId, env, envFingerprint: envFingerprint(env), baseUrl: options.baseUrl, iterations, at: new Date().toISOString() }, null, 2) + '\n',
  )
  await writeFile(join(outDir, 'samples.json'), JSON.stringify(results, null, 2) + '\n')

  return { runId, results, outPath: outDir }
}

/** Runs inside the page; must be self-contained. */
function readPageSample(): PageSample {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
  const paint = performance.getEntriesByType('paint')
  const observed = (window as typeof window & { __crustLcp?: number }).__crustLcp ?? 0
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]

  return {
    ttfb: nav.responseStart,
    fcp: paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0,
    lcp: observed,
    domContentLoaded: nav.domContentLoadedEventEnd,
    load: nav.loadEventEnd,
    transferBytes: nav.transferSize + resources.reduce((sum, r) => sum + r.transferSize, 0),
  }
}

function medianSample(samples: PageSample[]): PageSample {
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  }
  return {
    ttfb: median(samples.map((s) => s.ttfb)),
    fcp: median(samples.map((s) => s.fcp)),
    lcp: median(samples.map((s) => s.lcp)),
    domContentLoaded: median(samples.map((s) => s.domContentLoaded)),
    load: median(samples.map((s) => s.load)),
    transferBytes: median(samples.map((s) => s.transferBytes)),
  }
}
