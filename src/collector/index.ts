import { auditImages, type ImageFinding } from './images.ts'
import { observeStreaming, type StreamingSample } from './streaming.ts'
import { observeLoaf, observeVitals, type LoafSample, type VitalsSample } from './vitals.ts'

export type { ImageFinding, LoafSample, StreamingSample, VitalsSample }
export { auditImages, observeLoaf, observeStreaming, observeVitals }

export interface CollectorState {
  vitals: VitalsSample | null
  loaf: LoafSample | null
  streaming: StreamingSample | null
  images: ImageFinding[]
  /** Resources the collector itself loaded — excluded from every total (R7). */
  startedAt: number
}

export interface CollectorOptions {
  /** POST the final state here on pagehide (staging ingest). Off by default. */
  ingestUrl?: string
  /** Route pattern for the ingest payload, when the app knows it. */
  route?: string
}

declare global {
  interface Window {
    __CRUST_COLLECTOR__?: CollectorState
  }
}

/**
 * Start the runtime collector. Returns a disposer.
 *
 * Observer effect (R7) is the design constraint: everything is passive
 * observation, the state object is shared by reference (no polling, no copies),
 * and the image audit — the only active DOM walk — runs once, after `load`, in
 * an idle callback. The widget reads `window.__CRUST_COLLECTOR__` directly.
 */
export function startCollector(options: CollectorOptions = {}): () => void {
  if (typeof window === 'undefined') return () => {}
  if (window.__CRUST_COLLECTOR__) return () => {}

  const state: CollectorState = {
    vitals: null,
    loaf: null,
    streaming: null,
    images: [],
    startedAt: performance.now(),
  }
  window.__CRUST_COLLECTOR__ = state

  const disposers: (() => void)[] = []

  let lcpElement: Element | null = null
  disposers.push(
    observeVitals((sample) => {
      state.vitals = sample
    }),
  )
  disposers.push(
    observeLoaf((sample) => {
      state.loaf = sample
    }),
  )
  disposers.push(
    observeStreaming((sample) => {
      state.streaming = sample
    }),
  )

  // The audit needs the LCP element, which arrives via the vitals observer; a
  // buffered LCP observer here keeps the two decoupled.
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries() as (PerformanceEntry & { element?: Element })[]
      const last = entries[entries.length - 1]
      if (last?.element) lcpElement = last.element
    })
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
    disposers.push(() => lcpObserver.disconnect())
  } catch {
    // No LCP entry type — the audit runs without LCP-specific findings.
  }

  /**
   * The audit runs twice on purpose.
   *
   * The over-download check needs `naturalWidth`, which is 0 until the image has
   * decoded — and a lazy image below the fold has not even started. Auditing once
   * silently drops the highest-value finding on exactly the images most likely to
   * be oversized. So: an early pass for the structural findings, then a second
   * pass once the images that were still loading have settled.
   */
  const runAudit = (): void => {
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 200))
    idle(() => {
      state.images = auditImages(lcpElement)

      const pending = Array.from(document.querySelectorAll('img')).filter((img) => !img.complete)
      if (pending.length === 0) return

      let settled = 0
      const onSettle = (): void => {
        if (++settled < pending.length) return
        idle(() => {
          state.images = auditImages(lcpElement)
        })
      }
      for (const img of pending) {
        img.addEventListener('load', onSettle, { once: true })
        img.addEventListener('error', onSettle, { once: true })
      }
    })
  }
  if (document.readyState === 'complete') runAudit()
  else window.addEventListener('load', runAudit, { once: true })

  if (options.ingestUrl) {
    const flush = (): void => {
      const body = JSON.stringify({
        route: options.route ?? location.pathname,
        vitals: state.vitals,
        loafTotalBlockingTime: state.loaf?.totalBlockingTime ?? null,
        streamingFills: state.streaming?.fills ?? [],
        imageFindings: state.images.length,
        url: location.pathname,
        at: new Date().toISOString(),
      })
      // sendBeacon survives page teardown; fetch(keepalive) is the fallback.
      if (!navigator.sendBeacon?.(options.ingestUrl!, body)) {
        void fetch(options.ingestUrl!, { method: 'POST', body, keepalive: true }).catch(() => {})
      }
    }
    window.addEventListener('pagehide', flush, { once: true })
    disposers.push(() => window.removeEventListener('pagehide', flush))
  }

  return () => {
    for (const dispose of disposers) dispose()
    delete window.__CRUST_COLLECTOR__
  }
}
