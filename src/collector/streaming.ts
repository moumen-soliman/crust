/**
 * Shell engine layer 3: when did each Suspense hole actually fill.
 *
 * Next streams flight chunks through `self.__next_f.push(...)`, and React swaps
 * a fallback for real content with inline `$RC("B:0", "S:0")` calls. Boundary
 * ids are assigned in document order, so they line up with the ids layer 2 read
 * from the prerendered shell — the join needs no source access at all.
 *
 * Everything here sits behind a capability check that degrades to "streaming
 * view unavailable" rather than throwing (plan §8, Phase 6 item 4): `__next_f`
 * is an internal, and internals move on minor releases (R3).
 */

export interface BoundaryFill {
  /** `B:0`, `B:1`, … in document order — matches the shell's template ids. */
  boundaryId: string
  /** ms from navigation start when the boundary's content swapped in. */
  filledAt: number
}

export interface StreamingSample {
  supported: boolean
  reason: string | null
  fills: BoundaryFill[]
  /** ms of the last flight chunk seen — the stream's effective end. */
  lastChunkAt: number | null
}

type NextFlightTuple = [number, string?]
interface NextFlightArray extends Array<NextFlightTuple> {
  push(...items: NextFlightTuple[]): number
}

export function observeStreaming(onUpdate: (sample: StreamingSample) => void): () => void {
  const sample: StreamingSample = { supported: false, reason: null, fills: [], lastChunkAt: null }

  const globalWithFlight = self as typeof self & { __next_f?: NextFlightArray }

  if (!Array.isArray(globalWithFlight.__next_f)) {
    sample.reason = 'streaming view unavailable — __next_f not found on this Next version'
    onUpdate({ ...sample })
    return () => {}
  }

  sample.supported = true
  const queue = globalWithFlight.__next_f

  const record = (chunk: NextFlightTuple): void => {
    const now = performance.now()
    sample.lastChunkAt = now
    const payload = typeof chunk[1] === 'string' ? chunk[1] : ''
    // React's swap call names the boundary being resolved. The payload is
    // otherwise treated as opaque — parsing flight format would put us on the
    // wrong side of R3 for no additional signal.
    for (const match of payload.matchAll(/\$RC\("(B:\d+)"/g)) {
      sample.fills.push({ boundaryId: match[1]!, filledAt: now })
    }
  }

  for (const chunk of queue) record(chunk)

  const originalPush = queue.push.bind(queue)
  queue.push = (...items: NextFlightTuple[]): number => {
    for (const item of items) record(item)
    onUpdate({ ...sample, fills: [...sample.fills] })
    return originalPush(...items)
  }

  onUpdate({ ...sample, fills: [...sample.fills] })

  return () => {
    queue.push = originalPush
  }
}
