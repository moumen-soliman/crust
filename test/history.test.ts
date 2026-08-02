import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fetchHistory, pushHistory } from '../src/store/history-branch.ts'
import { renderLiveSection } from '../src/report/live.ts'
import type { CollectorState } from '../src/collector/index.ts'

const exec = promisify(execFile)
const git = (args: string[], cwd: string) => exec('git', args, { cwd })

async function makeRepoWithRemote(): Promise<{ work: string; remote: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'crust-hist-'))
  const remote = join(base, 'remote.git')
  const work = join(base, 'work')

  await git(['init', '-q', '--bare', remote], base)
  await git(['init', '-q', work], base)
  // An absolute URL, matching how real remotes look.
  await git(['remote', 'add', 'origin', remote], work)
  await writeFile(join(work, 'README.md'), 'x\n')
  await git(['add', 'README.md'], work)
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], work)
  await git(['push', '-q', 'origin', 'HEAD:main'], work)

  return { work, remote, base }
}

async function addSnapshot(work: string, id: string): Promise<void> {
  const dir = join(work, '.perf', 'builds', id.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ buildId: id, routes: [] }))
}

describe('perf-history branch', () => {
  it('publishes, stays idempotent, and restores into a fresh clone', async () => {
    const { work, remote, base } = await makeRepoWithRemote()
    await addSnapshot(work, 'ab1234')

    const first = await pushHistory(work)
    expect(first.pushed).toBe(true)

    // Nothing changed: a second run must not create an empty commit.
    const second = await pushHistory(work)
    expect(second.pushed).toBe(false)
    expect(second.detail).toMatch(/no new snapshots/)

    // Re-running must work at all - checking out `perf-history` locally would
    // fail here, because the branch already exists from the first run.
    await addSnapshot(work, 'cd5678')
    const third = await pushHistory(work)
    expect(third.pushed).toBe(true)

    // No temp branches left behind.
    const { stdout: branches } = await git(['branch', '--list', 'crust-history-*'], work)
    expect(branches.trim()).toBe('')

    const fresh = join(base, 'fresh')
    await git(['clone', '-q', remote, fresh], base)
    const fetched = await fetchHistory(fresh)
    expect(fetched.pushed).toBe(true)

    expect(JSON.parse(await readFile(join(fresh, '.perf/builds/ab/ab1234.json'), 'utf8'))).toMatchObject({
      buildId: 'ab1234',
    })
    expect(JSON.parse(await readFile(join(fresh, '.perf/builds/cd/cd5678.json'), 'utf8'))).toMatchObject({
      buildId: 'cd5678',
    })
  }, 30_000)

  it('reports rather than throws when there is no remote', async () => {
    const base = await mkdtemp(join(tmpdir(), 'crust-hist-'))
    await git(['init', '-q', base], base)
    await addSnapshot(base, 'ab1234')

    const result = await pushHistory(base)
    expect(result.pushed).toBe(false)
    expect(result.detail).toMatch(/no remote/)
  })

  it('reports rather than throws when the history branch does not exist yet', async () => {
    const { work } = await makeRepoWithRemote()
    const result = await fetchHistory(work)
    expect(result.pushed).toBe(false)
    expect(result.detail).toMatch(/no history branch yet/)
  }, 20_000)
})

describe('live section', () => {
  const state: CollectorState = {
    vitals: { lcp: 4000, lcpElement: 'h1', cls: 0.02, inp: null, ttfb: 12, fcp: 900 },
    loaf: { frames: [], totalBlockingTime: 120 },
    streaming: { supported: true, reason: null, fills: [{ boundaryId: 'B:0', filledAt: 850 }], pending: 0, lastChunkAt: 800 },
    images: [{ src: '/a.png', element: 'img', kind: 'raw-img', message: 'raw <img>' }],
    startedAt: 0,
  }

  it('wraps its markup in .crust so the shared stylesheet applies', () => {
    // Every rule is scoped under `.crust`; without the wrapper the panel renders
    // in the host page's fonts as unstyled text.
    expect(renderLiveSection(state)).toMatch(/^<div class="crust">/)
  })

  it('flags vitals past their thresholds', () => {
    const html = renderLiveSection(state)
    expect(html).toContain('stat warn') // LCP 4000ms is over 2500
    expect(html).toContain('4000 ms')
  })

  it('labels a fill it could not time instead of inventing one', () => {
    const untimed: CollectorState = {
      ...state,
      streaming: { supported: true, reason: null, fills: [{ boundaryId: 'B:0', filledAt: null }], pending: 0, lastChunkAt: null },
    }
    expect(renderLiveSection(untimed)).toContain('before collector start')
  })
})
