import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { shortHash } from '../core/hash.ts'
import type { Snapshot } from '../store/snapshot.ts'
import type { Breach } from './budgets.ts'

/**
 * The measurement Focus 3 needs and cannot invent: for every finding that would
 * block a merge, did the author agree it was a real regression?
 *
 * `ci` appends one row per blocking breach. Authors mark rows later. The rate is
 * disputed / (agreed + disputed); open rows are unfinished measurement, not a
 * vote. Nothing here produces the number - it only makes the number possible.
 */

export type FindingVerdict = 'open' | 'agreed' | 'disputed'

export interface RecordedFinding {
  /** Occurrence id - what `agree` / `dispute` address. Fresh per CI run. */
  id: string
  /**
   * Stable across identical breaches. Groups repeats of the same failure; never
   * used as the mark target, because one occurrence can be right and the next
   * wrong after a threshold change.
   */
  key: string
  recordedAt: string
  buildId: string
  baseBuildId: string | null
  gitSha: string | null
  branch: string | null
  pattern: string
  kind: Breach['kind']
  message: string
  blame: string | null
  verdict: FindingVerdict
  resolvedAt: string | null
  note: string | null
}

export interface FindingsRate {
  open: number
  agreed: number
  disputed: number
  /** agreed + disputed. The denominator the target applies to. */
  resolved: number
  /**
   * disputed / resolved. Null when nothing has been marked yet - reporting 0%
   * then would invent the one number the roadmap says must be measured.
   */
  disagreementRate: number | null
}

export const FINDINGS_FILE = 'findings.jsonl'

export function findingsPath(perfDir: string): string {
  return join(perfDir, FINDINGS_FILE)
}

/** Content address of the breach itself - same failure on two PRs shares a key. */
export function findingKey(breach: Breach): string {
  return shortHash(`${breach.kind}\0${breach.pattern}\0${breach.blame ?? ''}\0${breach.message}`)
}

export function recordedFromBreaches(
  breaches: Breach[],
  head: Snapshot,
  base: Snapshot | null,
  now = new Date(),
): RecordedFinding[] {
  const recordedAt = now.toISOString()
  return breaches.map((breach) => ({
    id: ulid(now.getTime()),
    key: findingKey(breach),
    recordedAt,
    buildId: head.buildId,
    baseBuildId: base?.buildId ?? null,
    gitSha: head.gitSha,
    branch: head.branch,
    pattern: breach.pattern,
    kind: breach.kind,
    message: breach.message,
    blame: breach.blame,
    verdict: 'open',
    resolvedAt: null,
    note: null,
  }))
}

export async function appendFindings(perfDir: string, findings: RecordedFinding[]): Promise<void> {
  if (findings.length === 0) return
  const path = findingsPath(perfDir)
  await mkdir(dirname(path), { recursive: true })
  const body = findings.map((finding) => JSON.stringify(finding)).join('\n') + '\n'
  await appendFile(path, body, 'utf8')
}

export async function readFindings(perfDir: string): Promise<RecordedFinding[]> {
  let raw: string
  try {
    raw = await readFile(findingsPath(perfDir), 'utf8')
  } catch {
    return []
  }

  const out: RecordedFinding[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as RecordedFinding)
    } catch {
      // A corrupted line must not hide the rest of a month of measurement.
    }
  }
  return out
}

/**
 * Rewrite the file with one row's verdict changed. JSONL is append-friendly for
 * recording and awkward for updates; the file stays small (one line per blocking
 * finding), so rewriting is the honest tool.
 */
export async function markFinding(
  perfDir: string,
  id: string,
  verdict: 'agreed' | 'disputed',
  note: string | null = null,
  now = new Date(),
): Promise<RecordedFinding> {
  const all = await readFindings(perfDir)
  const index = all.findIndex((finding) => finding.id === id)
  if (index < 0) throw new Error(`No recorded finding "${id}". Run \`crust findings list\`.`)

  const updated: RecordedFinding = {
    ...all[index]!,
    verdict,
    resolvedAt: now.toISOString(),
    note,
  }
  all[index] = updated
  await writeFindings(perfDir, all)
  return updated
}

async function writeFindings(perfDir: string, findings: RecordedFinding[]): Promise<void> {
  const path = findingsPath(perfDir)
  await mkdir(dirname(path), { recursive: true })
  if (findings.length === 0) {
    await writeFile(path, '', 'utf8')
    return
  }
  await writeFile(path, findings.map((finding) => JSON.stringify(finding)).join('\n') + '\n', 'utf8')
}

export function findingsRate(findings: RecordedFinding[]): FindingsRate {
  let open = 0
  let agreed = 0
  let disputed = 0
  for (const finding of findings) {
    if (finding.verdict === 'open') open++
    else if (finding.verdict === 'agreed') agreed++
    else disputed++
  }
  const resolved = agreed + disputed
  return {
    open,
    agreed,
    disputed,
    resolved,
    disagreementRate: resolved === 0 ? null : disputed / resolved,
  }
}
