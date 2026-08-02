import type { RenderingMode } from '../adapters/types.ts'

export type StoredMode = RenderingMode | 'unknown'

export interface ModeChange {
  before: StoredMode
  after: StoredMode
  /**
   * `regression` means the route got less static. `unknown` means one side is a
   * mode with no place on the scale, so the direction cannot be stated — never
   * assumed. Guessing here is how a CI check earns its first false failure.
   */
  direction: 'regression' | 'improvement' | 'unknown'
  /** The analyzer's explanation for the new mode, when it had one. */
  reason: string | null
}

/**
 * How static each mode is, most static first. The scale exists because the four
 * page modes are genuinely ordered — a route moving down it serves less HTML from
 * the edge and more from a render — and that ordering is what makes "this got
 * worse" a fact rather than an opinion.
 *
 * `ROUTE_HANDLER` and `unknown` are deliberately absent. A route handler is a
 * server function with no shell to lose, and `unknown` means the analyzer could
 * not tell; placing either on the scale would manufacture a direction out of a
 * gap in the analysis.
 */
const STATICNESS: Partial<Record<StoredMode, number>> = {
  STATIC: 4,
  ISR: 3,
  PARTIALLY_STATIC: 2,
  DYNAMIC: 1,
}

export function compareModes(
  before: StoredMode | null,
  after: StoredMode | null,
  reason: string | null,
): ModeChange | null {
  if (before === null || after === null) return null
  if (before === after) return null

  const a = STATICNESS[before]
  const b = STATICNESS[after]
  const direction = a === undefined || b === undefined ? 'unknown' : b < a ? 'regression' : 'improvement'

  return { before, after, direction, reason }
}

/**
 * `revalidate=N` is written by our own analyzer in exactly one place
 * (`renderingModeFor`), so reading it back is round-tripping our own field rather
 * than parsing a foreign format. It stays a string in the snapshot because
 * promoting it to a typed field would bump the schema version, and a bump makes
 * every snapshot already on the history branch incomparable — a steep price for
 * one integer.
 */
export function revalidateSeconds(reason: string | null): number | null {
  const match = reason?.match(/^revalidate=(\d+)$/)
  return match ? Number(match[1]) : null
}

export function modeLabel(mode: StoredMode): string {
  switch (mode) {
    case 'STATIC':
      return 'static'
    case 'PARTIALLY_STATIC':
      return 'partial'
    case 'ISR':
      return 'isr'
    case 'DYNAMIC':
      return 'dynamic'
    case 'ROUTE_HANDLER':
      return 'handler'
    default:
      return 'unknown'
  }
}
