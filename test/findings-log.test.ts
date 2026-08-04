import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendFindings,
  findingKey,
  findingsRate,
  markFinding,
  readFindings,
  recordedFromBreaches,
} from '../src/ci/findings-log.ts'
import type { Breach } from '../src/ci/budgets.ts'
import { snapshot } from './factories.ts'

const breach = (overrides: Partial<Breach> = {}): Breach => ({
  pattern: '/checkout',
  kind: 'rendering-mode',
  message: 'rendering mode dropped static -> dynamic',
  blame: 'cookies() at app/checkout/page.tsx:3',
  ...overrides,
})

describe('findings log', () => {
  it('gives identical breaches the same key and each occurrence its own id', () => {
    const head = snapshot({ buildId: 'h'.repeat(16), gitSha: 'a'.repeat(40) })
    const first = recordedFromBreaches([breach()], head, null, new Date('2026-08-04T10:00:00.000Z'))
    const second = recordedFromBreaches([breach()], head, null, new Date('2026-08-04T11:00:00.000Z'))

    expect(first[0]!.key).toBe(second[0]!.key)
    expect(first[0]!.key).toBe(findingKey(breach()))
    expect(first[0]!.id).not.toBe(second[0]!.id)
    expect(first[0]!.verdict).toBe('open')
  })

  it('appends, marks, and reports a disagreement rate over resolved rows only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-findings-'))
    const head = snapshot({ buildId: 'h'.repeat(16) })
    const rows = recordedFromBreaches(
      [breach(), breach({ pattern: '/cart', kind: 'cache', message: 'stopped being cached', blame: null })],
      head,
      snapshot({ buildId: 'b'.repeat(16) }),
      new Date('2026-08-04T12:00:00.000Z'),
    )
    await appendFindings(dir, rows)

    // A second run of the same failure is a second occurrence, not an overwrite.
    await appendFindings(dir, recordedFromBreaches([breach()], head, null, new Date('2026-08-04T13:00:00.000Z')))

    const all = await readFindings(dir)
    expect(all).toHaveLength(3)
    expect(findingsRate(all)).toEqual({
      open: 3,
      agreed: 0,
      disputed: 0,
      resolved: 0,
      // Null, not 0: nothing marked yet is unfinished measurement, not a perfect score.
      disagreementRate: null,
    })

    await markFinding(dir, all[0]!.id, 'agreed')
    await markFinding(dir, all[1]!.id, 'disputed', 'mode was intentional for auth')
    const after = await readFindings(dir)
    const rate = findingsRate(after)

    expect(rate).toEqual({
      open: 1,
      agreed: 1,
      disputed: 1,
      resolved: 2,
      disagreementRate: 0.5,
    })
    expect(after[1]!.note).toBe('mode was intentional for auth')
    expect(after[1]!.resolvedAt).toBeTruthy()

    // File stays valid JSONL after a mark rewrite.
    const raw = await readFile(join(dir, 'findings.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(3)
  })

  it('rejects marking an id that was never recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crust-findings-missing-'))
    await expect(markFinding(dir, 'nope', 'agreed')).rejects.toThrow(/No recorded finding/)
  })
})
