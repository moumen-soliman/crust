/**
 * Reason strings are produced in two places - `propagateDynamicTaint` and the
 * shell predictor's `ownTaint` - in two shapes:
 *
 *   cookies() at app/dashboard/page.tsx:18
 *   uncached fetch at lib/http.ts:3 via lib/products.ts
 *
 * They are formatted for a human to read, so this reads them back rather than
 * introducing a parallel structured field that would bump the snapshot schema and
 * strand every record already on the history branch.
 */
export interface ParsedReason {
  text: string
  /**
   * `cache` covers anything that stopped being cached - the class of regression
   * that produces no build error. `dynamic-api` is a deliberate read of request
   * state, which is at least visible in the source diff.
   */
  kind: 'cache' | 'dynamic-api' | 'other'
  /** `lib/http.ts:3`, when the reason names a call site. */
  site: string | null
  /** `cookies`, when a dynamic API is named. */
  api: string | null
}

const SITE = /\bat\s+([^\s:]+:\d+)/
const API = /^(\w+)\(\)\s+at\s+/

export function parseReason(text: string): ParsedReason {
  const site = text.match(SITE)?.[1] ?? null
  const api = text.match(API)?.[1] ?? null

  const kind: ParsedReason['kind'] = text.startsWith('uncached fetch')
    ? 'cache'
    : text.includes('not cached')
      ? 'cache'
      : api
        ? 'dynamic-api'
        : 'other'

  return { text, kind, site, api }
}

/**
 * The same root cause reaches different routes by different import paths, so the
 * ` via …` tail differs while the call site does not. Keying on the site collapses
 * those into one finding instead of reporting the same uncached fetch four times.
 */
export function reasonKey(text: string): string {
  const parsed = parseReason(text)
  return parsed.site ? `${parsed.api ?? parsed.kind}@${parsed.site}` : text
}

/** Drops the ` via …` provenance tail for display, keeping the call site. */
export function shortReason(text: string): string {
  const via = text.indexOf(' via ')
  return via === -1 ? text : text.slice(0, via)
}
