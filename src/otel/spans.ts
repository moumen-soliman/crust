/**
 * Phase 8 — server spans, deliberately minimal.
 *
 * The plan's position stands: build the full OTel integration only if real users
 * ask — their APM may already cover it. What ships here is the join, which is
 * the only crust-specific part: grouping Next's own spans by route and timing
 * each Suspense hole's server-side resume, which pairs with shell layer 3.
 *
 * Structurally typed rather than importing @opentelemetry/*: the interfaces
 * below match the SDK's ReadableSpan shape, so the processor plugs into any
 * OTel setup without crust taking on the dependency tree.
 *
 * Wire-up, in the app's instrumentation.ts (a supported API — never patch
 * server internals):
 *
 *   import { registerOTel } from '@vercel/otel'
 *   import { CrustSpanAggregator } from 'crust/otel'
 *
 *   const aggregator = new CrustSpanAggregator()
 *   export function register() {
 *     registerOTel({ serviceName: 'my-app', spanProcessors: [aggregator] })
 *   }
 */

/** Matches OTel's HrTime. */
export type HrTime = [seconds: number, nanoseconds: number]

/** The subset of ReadableSpan the aggregator touches. */
export interface SpanLike {
  name: string
  startTime: HrTime
  endTime: HrTime
  attributes: Record<string, unknown>
}

export interface RouteSpanStats {
  route: string
  count: number
  /** Milliseconds, running aggregates — bounded memory however long the server lives. */
  totalMs: number
  maxMs: number
  /** `fetch` spans under this route, by target host. */
  fetches: Record<string, { count: number; totalMs: number }>
}

export class CrustSpanAggregator {
  private readonly routes = new Map<string, RouteSpanStats>()

  /** SpanProcessor interface — called by the SDK. */
  onStart(): void {}

  onEnd(span: SpanLike): void {
    const route = routeOf(span)
    if (!route) return

    const stats = this.routes.get(route) ?? { route, count: 0, totalMs: 0, maxMs: 0, fetches: {} }
    const duration = durationMs(span)

    if (isRenderSpan(span)) {
      stats.count += 1
      stats.totalMs += duration
      stats.maxMs = Math.max(stats.maxMs, duration)
    }

    if (isFetchSpan(span)) {
      const host = hostOf(span) ?? 'unknown'
      const fetch = stats.fetches[host] ?? { count: 0, totalMs: 0 }
      fetch.count += 1
      fetch.totalMs += duration
      stats.fetches[host] = fetch
    }

    this.routes.set(route, stats)
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  /** Snapshot of aggregates, for an app-owned debug endpoint or log line. */
  stats(): RouteSpanStats[] {
    return [...this.routes.values()].sort((a, b) => b.totalMs - a.totalMs)
  }
}

/** Next sets `next.route` on its render spans; fetches carry `http.url`. */
function routeOf(span: SpanLike): string | null {
  const route = span.attributes['next.route']
  return typeof route === 'string' ? route : null
}

function isRenderSpan(span: SpanLike): boolean {
  return span.name.startsWith('render route') || span.attributes['next.span_type'] === 'BaseServer.handleRequest'
}

function isFetchSpan(span: SpanLike): boolean {
  return span.attributes['next.span_type'] === 'AppRender.fetch' || typeof span.attributes['http.url'] === 'string'
}

function hostOf(span: SpanLike): string | null {
  const url = span.attributes['http.url']
  if (typeof url !== 'string') return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function durationMs(span: SpanLike): number {
  const [startSeconds, startNanos] = span.startTime
  const [endSeconds, endNanos] = span.endTime
  return (endSeconds - startSeconds) * 1000 + (endNanos - startNanos) / 1e6
}
