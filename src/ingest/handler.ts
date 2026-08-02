import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Staging ingest (plan §8, Phase 7): a write-only endpoint the runtime collector
 * beacons to from a staging deployment.
 *
 * Threat model (R8): an open POST appending to a history table is free
 * vandalism, and the manifest already leaks the route table if left unguarded.
 * So the handler is:
 *
 *  - **authenticated** - a shared token, checked in constant time;
 *  - **rate limited** - token bucket per client, in memory (staging boxes are
 *    single-instance; a distributed limiter would be solving production's
 *    problem on a box the plan says never runs this);
 *  - **write-only** - nothing can be read back through it; the analysis side
 *    reads the files directly;
 *  - **bounded** - oversized and malformed payloads are dropped, not stored.
 *
 * Server-side store only - never sync staging data back to git (plan §8).
 */

export interface IngestOptions {
  /** Shared secret; the collector sends it as a bearer token. */
  secret: string
  /** Directory samples are appended to, one JSONL file per day. */
  dir?: string
  /** Requests allowed per client per minute. */
  ratePerMinute?: number
  /** Maximum accepted payload, bytes. */
  maxBytes?: number
}

interface Bucket {
  tokens: number
  refilledAt: number
}

const MAX_BUCKETS = 10_000

export function createIngestHandler(options: IngestOptions): (request: Request) => Promise<Response> {
  const dir = options.dir ?? '.perf-server/samples'
  const ratePerMinute = options.ratePerMinute ?? 60
  const maxBytes = options.maxBytes ?? 32 * 1024
  const buckets = new Map<string, Bucket>()

  if (!options.secret || options.secret.length < 16) {
    throw new Error('crust ingest: secret must be at least 16 characters')
  }
  const expected = digest(options.secret)

  return async function ingest(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })

    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    // Compare digests, not strings: equal-length inputs for timingSafeEqual, and
    // no early-exit length leak.
    if (!timingSafeEqual(digest(token), expected)) return new Response(null, { status: 401 })

    const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (!takeToken(buckets, client, ratePerMinute)) return new Response(null, { status: 429 })

    const body = await request.text()
    if (body.length === 0 || body.length > maxBytes) return new Response(null, { status: 413 })

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (typeof parsed !== 'object' || parsed === null) return new Response(null, { status: 400 })

    const day = new Date().toISOString().slice(0, 10)
    const file = join(dir, `${day}.jsonl`)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify({ ...parsed, receivedAt: new Date().toISOString() }) + '\n', 'utf8')

    // 204 with no body: write-only means the response carries nothing to probe.
    return new Response(null, { status: 204 })
  }
}

function takeToken(buckets: Map<string, Bucket>, client: string, ratePerMinute: number): boolean {
  const now = Date.now()
  let bucket = buckets.get(client)
  if (!bucket) {
    // Cap the map so an attacker rotating client addresses cannot grow it forever.
    if (buckets.size >= MAX_BUCKETS) buckets.clear()
    bucket = { tokens: ratePerMinute, refilledAt: now }
    buckets.set(client, bucket)
  }

  const elapsed = now - bucket.refilledAt
  bucket.tokens = Math.min(ratePerMinute, bucket.tokens + (elapsed / 60_000) * ratePerMinute)
  bucket.refilledAt = now

  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function digest(value: string): Buffer {
  return createHmac('sha256', 'crust-ingest').update(value).digest()
}
