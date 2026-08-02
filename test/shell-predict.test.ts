import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildModuleGraph, createResolver, propagateDynamicTaint } from '../src/analyze/module-graph.ts'
import { createIndex } from '../src/core/workspace.ts'
import { predictShell } from '../src/shell/predict.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('shell component relationships', () => {
  it('uses the import edge to disambiguate same-named components', async () => {
    const { graph, entry } = await fixture({
      'page.tsx': `
        import { Suspense } from 'react'
        import { Panel } from './dynamic-panel'
        import { Panel as OtherPanel } from './static-panel'
        export default function Page() { return <Suspense fallback={<p>wait</p>}><Panel /></Suspense> }
      `,
      'dynamic-panel.tsx': `
        import { cookies } from 'next/headers'
        export function Panel() { cookies(); return <p>dynamic</p> }
      `,
      'static-panel.tsx': `export function Panel() { return <p>static</p> }`,
    })

    const prediction = predictShell(graph, propagateDynamicTaint(graph), entry, 'cache-components')

    expect(prediction.predictedHoles).toEqual([
      expect.objectContaining({ component: 'Panel', reason: expect.stringContaining('cookies()') }),
    ])
    expect(prediction.unknown).not.toEqual(expect.arrayContaining([expect.stringContaining('more than one file')]))
  })

  it('does not call an imported dependency an unresolved source relationship', async () => {
    const { graph, entry } = await fixture({
      'page.tsx': `
        import { Suspense } from 'react'
        import NextLink from 'next/link'
        export default function Page() { return <Suspense fallback={<p>wait</p>}><NextLink href="/">Home</NextLink></Suspense> }
      `,
    })

    const prediction = predictShell(graph, propagateDynamicTaint(graph), entry, 'cache-components')
    expect(prediction.unknown).toEqual([])
  })
})

async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crust-shell-source-')))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, source, 'utf8')
  }
  const entry = 'page.tsx'
  const graph = await buildModuleGraph(
    join(root, entry),
    createIndex(root, Object.keys(files)),
    createResolver(null),
  )
  return { graph, entry }
}
