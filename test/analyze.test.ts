import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeBuild, renderingModeFor } from '../src/analyze/analyze.ts'
import { readSourceFacts } from '../src/analyze/source-file.ts'
import { packageNameOf } from '../src/analyze/attribution.ts'
import { createIndex, findWorkspaceRoot } from '../src/core/workspace.ts'
import { layoutChainFor } from '../src/analyze/module-graph.ts'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'basic')

describe('build discovery', () => {
  it('explains how to build an app or target one in a monorepo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'crust-no-build-'))

    await expect(analyzeBuild({ cwd, toolVersion: 'test' })).rejects.toThrow(
      /Run `next build` in the app directory[\s\S]*--cwd apps\/web[\s\S]*--dist-dir <directory>/,
    )
  })
})

describe('rendering mode from a declaration', () => {
  // Next lists a force-dynamic route in neither `prerender-manifest.routes` nor
  // `dynamicRoutes`, so the artifacts say nothing at all. Before this, the most
  // explicit way to make a route dynamic classified as `unknown` - and an unknown
  // transition is never failed, so `crust ci` stayed silent on it.
  const ctx = { pattern: '/[locale]/about', prerender: { routes: {}, dynamicRoutes: {} } } as never

  it('trusts dynamic = force-dynamic declared on the page', () => {
    expect(renderingModeFor(ctx, [], null, { dynamic: 'force-dynamic' })).toEqual({
      mode: 'DYNAMIC',
      reason: 'route config: dynamic = "force-dynamic"',
    })
  })

  it('names the layout when the declaration is above the page', () => {
    const result = renderingModeFor(ctx, [], null, { 'app/[locale]/layout.tsx:dynamic': 'force-dynamic' })
    expect(result.mode).toBe('DYNAMIC')
    expect(result.reason).toBe('route config: dynamic = "force-dynamic" in app/[locale]/layout.tsx')
  })

  it('still refuses to guess when nothing declares or explains it', () => {
    expect(renderingModeFor(ctx, [], null, { revalidate: 0, runtime: 'edge' }).mode).toBe('unknown')
  })
})

describe('source facts', () => {
  it('finds a dynamic API and the component it sits in', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'app/dashboard/page.tsx'), 'app/dashboard/page.tsx')
    expect(facts.dynamicApis).toHaveLength(1)
    expect(facts.dynamicApis[0]).toMatchObject({ name: 'cookies', inFunction: 'Theme' })
    expect(facts.defaultExportName).toBe('Dashboard')
  })

  it('records a Suspense boundary with its fallback and children', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'app/dashboard/page.tsx'), 'app/dashboard/page.tsx')
    const dashboard = facts.components.find((c) => c.name === 'Dashboard')
    expect(dashboard?.suspense).toHaveLength(1)
    expect(dashboard?.suspense[0]?.fallback).toEqual(['p'])
    expect(dashboard?.suspense[0]?.children).toEqual(['Theme'])
  })

  it('excludes a boundary subtree from what a component renders directly', async () => {
    // `renders` means "in the shell". Counting the boundary's children here would
    // classify the postponed component as static.
    const facts = await readSourceFacts(join(FIXTURE, 'app/dashboard/page.tsx'), 'app/dashboard/page.tsx')
    const dashboard = facts.components.find((c) => c.name === 'Dashboard')
    expect(dashboard?.renders).not.toContain('Theme')
    expect(dashboard?.renders).toContain('h1')
  })

  it('detects a client component directive', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'components/Gallery.tsx'), 'components/Gallery.tsx')
    expect(facts.isClientComponent).toBe(true)
  })

  it('treats a barrel re-export as a graph edge', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'components/index.ts'), 'components/index.ts')
    // `export { Hero } from './Hero'` - missing these ends the walk one file early,
    // which is exactly where barrel over-inclusion hides.
    expect(facts.imports.map((i) => i.specifier).sort()).toEqual(['./Counter', './Gallery', './Hero'])
  })

  it('does not mistake a string interpolation for an opaque component', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'components/Hero.tsx'), 'components/Hero.tsx')
    // `<h1>{title}</h1>` is a prop, not a component held in a variable.
    expect(facts.components[0]?.hasOpaqueChildren).toBe(false)
  })

  it('reads fetch caching intent', async () => {
    const facts = await readSourceFacts(join(FIXTURE, 'lib/http.ts'), 'lib/http.ts')
    expect(facts.fetches[0]).toMatchObject({ caching: 'no-store', inFunction: 'fetchJson' })
  })
})

describe('packageNameOf', () => {
  it('skips the pnpm virtual store segment', () => {
    expect(
      packageNameOf('/app/node_modules/.pnpm/next@16.2.12_react@19/node_modules/next/dist/client/index.js'),
    ).toBe('next')
  })

  it('keeps the scope on scoped packages', () => {
    expect(packageNameOf('/app/node_modules/@sentry/nextjs/build/index.js')).toBe('@sentry/nextjs')
  })

  it('returns null when there is no node_modules segment', () => {
    expect(packageNameOf('webpack://_N_E/../../src/client/app-router.tsx')).toBeNull()
  })
})

describe('workspace', () => {
  it('stops at the repository boundary', async () => {
    // Without this the walk finds stray lockfiles above the repo and anchors
    // every source path there.
    const root = await findWorkspaceRoot(FIXTURE)
    expect(root).toBe(join(import.meta.dirname, '..'))
  })
})

describe('layoutChainFor', () => {
  it('collects layouts from the root down to the page', () => {
    const index = createIndex('/repo', [
      'app/layout.tsx',
      'app/products/layout.tsx',
      'app/products/[slug]/page.tsx',
    ])
    expect(layoutChainFor('app/products/[slug]/page.tsx', index)).toEqual([
      'app/layout.tsx',
      'app/products/layout.tsx',
    ])
  })
})
