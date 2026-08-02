/**
 * Shell engine layer 3: when did each Suspense hole actually fill.
 *
 * React emits a boundary completion as an inline `<script>` containing
 * `$RC("B:0","S:0")` — appended to the document as the stream progresses. It is
 * **not** part of the `__next_f` flight payload, which carries the RSC data
 * separately. Watching only `__next_f` finds the chunks but never the swaps.
 *
 * Boundary ids are assigned in document order, so `B:0` here is the same `B:0`
 * layer 2 read out of the prerendered shell — the join needs no source access.
 *
 * Everything sits behind capability checks that degrade to "unavailable" rather
 * than throwing: these are internals and internals move on minor releases (R3).
 */

export interface BoundaryFill {
  /** `B:0`, `B:1`, … in document order — matches the shell's template ids. */
  boundaryId: string
  /**
   * ms from navigation start when the swap was observed, or null when it had
   * already happened before the collector started. A collector mounted in an
   * effect runs after hydration, so early boundaries are legitimately unobserved
   * — reporting a fabricated timestamp would be worse than reporting none.
   */
  filledAt: number | null
}

export interface StreamingSample {
  supported: boolean
  reason: string | null
  fills: BoundaryFill[]
  /** Boundaries still showing a fallback right now. */
  pending: number
  /** ms of the last flight chunk observed arriving, or null if none were. */
  lastChunkAt: number | null
}

type NextFlightTuple = [number, string?]
interface NextFlightArray extends Array<NextFlightTuple> {
  push(...items: NextFlightTuple[]): number
}

const COMPLETION = /\$RC\("(B:[^"]+)"/g

export function observeStreaming(onUpdate: (sample: StreamingSample) => void): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }

  const sample: StreamingSample = {
    supported: true,
    reason: null,
    fills: [],
    pending: countPendingBoundaries(),
    lastChunkAt: null,
  }

  const seen = new Set<string>()
  const emit = (): void => onUpdate({ ...sample, fills: [...sample.fills] })

  const recordScript = (text: string, at: number | null): void => {
    COMPLETION.lastIndex = 0
    for (const match of text.matchAll(COMPLETION)) {
      const boundaryId = match[1]!
      if (seen.has(boundaryId)) continue
      seen.add(boundaryId)
      sample.fills.push({ boundaryId, filledAt: at })
    }
  }

  // Everything already in the document resolved before we were listening.
  document.querySelectorAll('script:not([src])').forEach((script) => {
    recordScript(script.textContent ?? '', null)
  })

  if (seen.size === 0 && sample.pending === 0 && !hasBoundaryMarkers()) {
    sample.supported = false
    sample.reason = 'no Suspense boundaries on this route'
  }

  // Future completions arrive as newly appended scripts; time those precisely.
  const observer = new MutationObserver((records) => {
    let changed = false
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeName !== 'SCRIPT') return
        const before = seen.size
        recordScript(node.textContent ?? '', performance.now())
        if (seen.size !== before) changed = true
      })
    }
    const pending = countPendingBoundaries()
    if (pending !== sample.pending) {
      sample.pending = pending
      changed = true
    }
    if (changed) emit()
  })
  observer.observe(document, { childList: true, subtree: true })

  // Flight chunk arrival is a separate, complementary signal: it tells you when
  // the data landed, while the completion script tells you when the DOM swapped.
  const globalWithFlight = self as typeof self & { __next_f?: NextFlightArray }
  let restoreFlight: (() => void) | null = null

  if (Array.isArray(globalWithFlight.__next_f)) {
    const queue = globalWithFlight.__next_f
    const originalPush = queue.push.bind(queue)
    queue.push = (...items: NextFlightTuple[]): number => {
      // Only future pushes get a timestamp; replaying the existing queue would
      // stamp every chunk with the moment the collector happened to start.
      sample.lastChunkAt = performance.now()
      emit()
      return originalPush(...items)
    }
    restoreFlight = () => {
      queue.push = originalPush
    }
  }

  emit()

  return () => {
    observer.disconnect()
    restoreFlight?.()
  }
}

/** `<!--$?-->` marks a boundary still showing its fallback. */
function countPendingBoundaries(): number {
  return countComments('$?')
}

function hasBoundaryMarkers(): boolean {
  return countComments('$') > 0 || countComments('$?') > 0
}

function countComments(data: string): number {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT)
  let count = 0
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue === data) count++
  }
  return count
}
