/**
 * Web Vitals via raw PerformanceObserver.
 *
 * Not the `web-vitals` package: the collector ships into the user's page, where
 * every dependency is bundle weight and a version to reconcile with the host
 * app. LCP, CLS and INP from the raw entries is ~100 lines; the library earns
 * its keep for attribution edge cases the stamping transform would need anyway
 * (R4), which is not built.
 */

export interface VitalsSample {
  /** Largest Contentful Paint, ms from navigation start. */
  lcp: number | null
  /** Element that was the LCP candidate, as a readable descriptor. */
  lcpElement: string | null
  /** Cumulative Layout Shift, session-window scoring. */
  cls: number
  /** Interaction to Next Paint, ms (98th percentile approximation: worst-8 rule). */
  inp: number | null
  /** Time to First Byte, ms. */
  ttfb: number | null
  /** First Contentful Paint, ms. */
  fcp: number | null
}

export interface LoafSample {
  /** Long animation frames over 50ms: when, how long, and the worst script. */
  frames: { start: number; duration: number; script: string | null }[]
  totalBlockingTime: number
}

type Unobserve = () => void

export function observeVitals(onUpdate: (sample: VitalsSample) => void): Unobserve {
  const sample: VitalsSample = { lcp: null, lcpElement: null, cls: 0, inp: null, ttfb: null, fcp: null }
  const observers: PerformanceObserver[] = []
  const interactionDurations: number[] = []

  const emit = () => onUpdate({ ...sample })

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (nav) sample.ttfb = nav.responseStart

  observe(observers, 'paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') sample.fcp = entry.startTime
    }
    emit()
  })

  observe(
    observers,
    'largest-contentful-paint',
    (entries) => {
      const last = entries[entries.length - 1] as (PerformanceEntry & { element?: Element }) | undefined
      if (!last) return
      sample.lcp = last.startTime
      sample.lcpElement = last.element ? describeElement(last.element) : null
      emit()
    },
    { buffered: true },
  )

  // CLS session windows: shifts within 1s of each other (5s cap) group into a
  // window; the reported value is the worst window, matching how CrUX scores it.
  let windowValue = 0
  let windowStart = 0
  let windowLast = 0
  observe(
    observers,
    'layout-shift',
    (entries) => {
      for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (entry.hadRecentInput) continue
        if (entry.startTime - windowLast > 1000 || entry.startTime - windowStart > 5000) {
          windowValue = 0
          windowStart = entry.startTime
        }
        windowValue += entry.value
        windowLast = entry.startTime
        sample.cls = Math.max(sample.cls, windowValue)
      }
      emit()
    },
    { buffered: true },
  )

  observe(
    observers,
    'event',
    (entries) => {
      for (const entry of entries as (PerformanceEventTiming & { interactionId?: number })[]) {
        if (!entry.interactionId) continue
        interactionDurations.push(entry.duration)
      }
      if (interactionDurations.length > 0) {
        // INP: the worst interaction, except one outlier is forgiven per 50.
        const sorted = [...interactionDurations].sort((a, b) => b - a)
        const index = Math.min(sorted.length - 1, Math.floor(interactionDurations.length / 50))
        sample.inp = sorted[index] ?? null
        emit()
      }
    },
    { buffered: true, durationThreshold: 40 } as PerformanceObserverInit,
  )

  return () => {
    for (const observer of observers) observer.disconnect()
  }
}

export function observeLoaf(onUpdate: (sample: LoafSample) => void): Unobserve {
  const sample: LoafSample = { frames: [], totalBlockingTime: 0 }
  const observers: PerformanceObserver[] = []

  observe(
    observers,
    'long-animation-frame',
    (entries) => {
      for (const entry of entries as (PerformanceEntry & {
        scripts?: { sourceURL?: string; invokerType?: string; duration: number }[]
      })[]) {
        const worst = (entry.scripts ?? []).reduce<{ sourceURL?: string; duration: number } | null>(
          (a, b) => (a && a.duration >= b.duration ? a : b),
          null,
        )
        sample.frames.push({
          start: entry.startTime,
          duration: entry.duration,
          script: worst?.sourceURL ?? null,
        })
        sample.totalBlockingTime += Math.max(0, entry.duration - 50)
      }
      onUpdate({ ...sample, frames: [...sample.frames] })
    },
    { buffered: true },
  )

  return () => {
    for (const observer of observers) observer.disconnect()
  }
}

/** Unsupported entry types throw at observe(); each type degrades independently. */
function observe(
  pool: PerformanceObserver[],
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  extra: PerformanceObserverInit = {},
): void {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()))
    observer.observe({ type, ...extra } as PerformanceObserverInit)
    pool.push(observer)
  } catch {
    // This browser does not support the entry type; the metric reads null.
  }
}

export function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : ''
  const cls =
    typeof element.className === 'string' && element.className
      ? `.${element.className.split(/\s+/).slice(0, 2).join('.')}`
      : ''
  return `${element.tagName.toLowerCase()}${id}${cls}`
}
