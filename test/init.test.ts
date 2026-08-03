import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveStarterBudgets } from '../src/init/budgets.ts'
import { ciConfigFor } from '../src/init/ci.ts'
import { chooseNextApp, detectCiProvider, detectNodeMajor, detectPackageManager } from '../src/init/detect.ts'
import { incomparableReason, runInit } from '../src/init/init.ts'
import { renderInitTerminal } from '../src/init/render.tsx'
import { route, snapshot as makeSnapshot } from './factories.ts'
import type { NextApp } from '../src/init/detect.ts'
import type { RouteSnapshot } from '../src/store/snapshot.ts'

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crust-init-'))
  // A .git marker stops findWorkspaceRoot walking up into the real repository
  // that holds the OS temp directory on some machines.
  await mkdir(join(root, '.git'), { recursive: true })
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents, 'utf8')
  }
  return root
}

const app = (overrides: Partial<NextApp> = {}): NextApp => ({
  dir: '/repo/apps/web',
  relativeDir: 'apps/web',
  packageName: 'web',
  hasBuildScript: true,
  hasConfig: true,
  ...overrides,
})

const shelled = (ratio: number, overrides: Partial<RouteSnapshot> = {}): RouteSnapshot =>
  route({
    shell: {
      predictedStatic: [],
      predictedHoles: [],
      actual: { htmlPath: 'server/app/index.html', bytes: 1024, holes: 0, boundaryIds: [], shellRatio: ratio },
      agreement: 1,
      unknown: [],
    },
    ...overrides,
  })

describe('init: app detection', () => {
  it('refuses to pick between several apps and names them', async () => {
    const root = await workspace({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'package.json': '{"name":"root"}',
      'apps/web/package.json': '{"name":"web","dependencies":{"next":"16.2.12"}}',
      'apps/admin/next.config.ts': 'export default {}\n',
    })

    const choice = await chooseNextApp(root, root)
    expect(choice.app).toBeNull()
    expect(choice.how).toBe('ambiguous')
    expect(choice.candidates.map((candidate) => candidate.relativeDir).sort()).toEqual(['apps/admin', 'apps/web'])
  })

  it('takes the app containing cwd over any other candidate', async () => {
    const root = await workspace({
      'apps/web/package.json': '{"name":"web","dependencies":{"next":"16.2.12"}}',
      'apps/admin/package.json': '{"name":"admin","dependencies":{"next":"16.2.12"}}',
    })

    const choice = await chooseNextApp(root, join(root, 'apps', 'admin', 'app'))
    expect(choice.how).toBe('cwd')
    expect(choice.app?.relativeDir).toBe('apps/admin')
  })

  it('reads the package manager, CI provider and Node version from the repository', async () => {
    const root = await workspace({
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      '.nvmrc': '20.11.0\n',
      '.github/workflows/test.yml': 'name: test\n',
      'package.json': '{"name":"root","engines":{"node":">=22"},"packageManager":"pnpm@9.15.4"}',
    })

    expect(await detectPackageManager(root)).toEqual({ name: 'pnpm', declaredVersion: '9.15.4' })
    expect((await detectCiProvider(root)).provider).toBe('github')
    // .nvmrc is the project's own statement, so it beats engines and the running Node.
    expect(await detectNodeMajor(root, root)).toEqual({ major: 20, how: '.nvmrc' })
  })

  it('ignores a packageManager field that disagrees with the lockfile', async () => {
    const root = await workspace({
      'package-lock.json': '{}',
      'package.json': '{"name":"root","packageManager":"yarn@4.5.0"}',
    })

    expect(await detectPackageManager(root)).toEqual({ name: 'npm', declaredVersion: null })
  })

  it('never generates an odd Node major it only inferred from the local runtime', async () => {
    const root = await workspace({ 'package.json': '{"name":"root"}' })
    const choice = await detectNodeMajor(root, root)

    expect(choice.major % 2).toBe(0)
    expect(choice.major).toBeGreaterThanOrEqual(20)
    expect(choice.how).toContain('LTS')
  })
})

describe('init: starter budgets', () => {
  it('derives a ceiling above the heaviest route and explains every number', () => {
    const starter = deriveStarterBudgets(
      makeSnapshot({
        routes: [route({ pattern: '/', firstLoadBytes: 100_000 }), route({ pattern: '/heavy', firstLoadBytes: 243_000 })],
      }),
    )

    // 243 kB + 10% is 267.3 kB, rounded up to the next 10 kB - and nothing breaches it today.
    expect(starter?.budgets.defaultFirstLoadBytes).toBe(270_000)
    expect(starter!.budgets.defaultFirstLoadBytes!).toBeGreaterThan(243_000)
    expect(starter?.budgets.maxGrowth).toBe(0.05)
    expect(starter?.budgets.allowRegression).toBeUndefined()
    expect(starter?.budgets['//'].join('\n')).toContain('/heavy')
    expect(starter?.budgets['//'].join('\n')).toContain('chosen, not measured')
  })

  it('floors the shell below the lowest measured route, in a value JSON can hold', () => {
    const starter = deriveStarterBudgets(
      makeSnapshot({ routes: [shelled(1), shelled(0.42, { pattern: '/dashboard' })] }),
    )

    expect(starter?.budgets.defaultMinShellRatio).toBe(0.3)
    expect(JSON.stringify(starter?.budgets.defaultMinShellRatio)).toBe('0.3')
    expect(starter?.notes.join('\n')).toContain('/dashboard')
  })

  it('omits a shell floor rather than deriving one from nothing', () => {
    const nothingMeasured = deriveStarterBudgets(makeSnapshot({ routes: [route()] }))
    expect(nothingMeasured?.budgets.defaultMinShellRatio).toBeUndefined()
    expect(nothingMeasured?.notes.join('\n')).toContain('no route in this build emitted a static shell')

    // A shell this low cannot be floored without failing the build it came from.
    const alreadyLow = deriveStarterBudgets(makeSnapshot({ routes: [shelled(0.05)] }))
    expect(alreadyLow?.budgets.defaultMinShellRatio).toBeUndefined()
    expect(alreadyLow?.notes.join('\n')).toContain('too low to floor')
  })

  it('has nothing to derive from when no route has a size', () => {
    expect(deriveStarterBudgets(makeSnapshot({ routes: [route({ firstLoadBytes: 0 })] }))).toBeNull()
  })
})

describe('init: CI configuration', () => {
  it('pins the crust version and builds where the app actually lives', () => {
    const config = ciConfigFor({
      provider: 'github',
      toolVersion: '9.9.9',
      packageManager: 'pnpm',
      app: app(),
      distDir: '.next',
      baseline: 'develop',
      nodeMajor: 22,
    })

    expect(config.path).toBe('.github/workflows/crust.yml')
    expect(config.kind).toBe('workflow')
    expect(config.contents).toContain('crust-version: 9.9.9')
    // The action lives on master; `@main` resolves to nothing and fails the run
    // before any step executes.
    expect(config.contents).toContain('moumen-soliman/crust/action@master')
    expect(config.contents).not.toContain('action@main')
    expect(config.contents).toContain('pnpm/action-setup@v4')
    expect(config.contents).toContain('version: 10')
    expect(config.contents).toContain('cache: pnpm')
    expect(config.contents).toContain('working-directory: apps/web')
    // The baseline branch must build too, or a PR has no merge-base snapshot.
    expect(config.contents).toContain('branches: [develop]')
    expect(config.contents).toContain('baseline: develop')
  })

  it('defers to the packageManager field instead of pinning a second pnpm version', () => {
    const config = ciConfigFor({
      provider: 'github',
      toolVersion: '9.9.9',
      packageManager: 'pnpm',
      packageManagerVersion: '9.15.4',
      app: app(),
      distDir: '.next',
      baseline: 'main',
      nodeMajor: 22,
    })

    expect(config.contents).toContain('pnpm/action-setup@v4')
    expect(config.contents).not.toContain('version: 10')
    expect(config.contents).toContain('version comes from package.json packageManager')
  })

  it('falls back to next build when the app declares no build script', () => {
    const config = ciConfigFor({
      provider: 'github',
      toolVersion: '9.9.9',
      packageManager: 'npm',
      app: app({ hasBuildScript: false, relativeDir: '.' }),
      distDir: 'build',
      baseline: 'main',
      nodeMajor: 22,
    })

    expect(config.contents).toContain('npx --yes next build')
    expect(config.contents).toContain('dist-dir: build')
    expect(config.contents).not.toContain('working-directory')
  })

  it('emits a pasteable job for providers that keep one pipeline file', () => {
    const gitlab = ciConfigFor({
      provider: 'gitlab',
      toolVersion: '9.9.9',
      packageManager: 'yarn',
      app: app(),
      distDir: '.next',
      baseline: 'main',
      nodeMajor: 22,
    })

    expect(gitlab.kind).toBe('snippet')
    expect(gitlab.path).toBe('.perf/ci/gitlab-ci.crust.yml')
    expect(gitlab.contents).toContain('npx --yes @moumensoliman/crust@9.9.9 ci main --cwd apps/web --comment')
    expect(gitlab.contents).toContain('cd apps/web && yarn run build')
  })
})

describe('init: the command', () => {
  it('stops on a project with no build, and says what to run', async () => {
    const root = await workspace({
      'package.json': '{"name":"site","scripts":{"build":"next build"},"dependencies":{"next":"16.2.12"}}',
      'next.config.ts': 'export default {}\n',
    })

    const result = await runInit({ cwd: root, toolVersion: 'test' })
    expect(result.ok).toBe(false)
    expect(result.files).toEqual([])

    const output = renderInitTerminal(result, 100)
    expect(output).toContain('Production build')
    expect(output).toContain('npm run build')
    expect(output).toContain('Setup stopped')
  })

  it('names the apps to choose between instead of guessing', async () => {
    const root = await workspace({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': '{"name":"web","dependencies":{"next":"16.2.12"}}',
      'apps/docs/package.json': '{"name":"docs","dependencies":{"next":"16.2.12"}}',
    })

    const result = await runInit({ cwd: root, toolVersion: 'test' })
    expect(result.ok).toBe(false)
    expect(renderInitTerminal(result, 100)).toContain('crust init --cwd apps/web')
  })
})

describe('init: stored snapshots that cannot serve as a baseline', () => {
  // A count of stored snapshots is not a baseline. Reporting one as the other is
  // how a project is told it is set up and then gets "nothing to compare" in CI.
  const head = makeSnapshot({ schemaVersion: 4, bundler: 'turbopack', nextVersion: '16.2.6' })

  it('names the schema gap, which re-analysing the baseline fixes', () => {
    const old = makeSnapshot({ schemaVersion: 1, bundler: 'turbopack', nextVersion: '16.2.6' })
    expect(incomparableReason(head, [old])).toBe('they were written under snapshot schema v1, this one is v4')
  })

  it('names a bundler or framework gap, which re-analysing does not fix', () => {
    const webpack = makeSnapshot({ schemaVersion: 4, bundler: 'webpack', nextVersion: '16.2.6' })
    expect(incomparableReason(head, [webpack])).toContain('built with webpack')

    const next15 = makeSnapshot({ schemaVersion: 4, bundler: 'turbopack', nextVersion: '15.4.1' })
    expect(incomparableReason(head, [next15])).toBe('they were built on Next 15, this one on Next 16')
  })

  it('falls back to the route-identity case when everything else matches', () => {
    const renamed = makeSnapshot({
      schemaVersion: 4,
      bundler: 'turbopack',
      nextVersion: '16.2.6',
      routes: [route({ id: 'app/old/page.tsx' })],
    })
    expect(incomparableReason(head, [renamed])).toBe('they share no route with this build')
  })
})

describe('init: the report', () => {
  it('states the rules that need no budget file, and how to see one fail', () => {
    const result = {
      ok: true,
      root: '/repo',
      app: app(),
      snapshot: makeSnapshot(),
      baseline: 'main',
      dryRun: false,
      files: [{ path: '.perf/budgets.json', status: 'written' as const, detail: null }],
      steps: [
        {
          title: 'Enforced with no config',
          status: 'ok' as const,
          detail: '3 regression rules',
          lines: ['- a route became less static'],
        },
      ],
      nextSteps: ['See it fail on purpose: add `export const dynamic = \'force-dynamic\'`'],
    }

    const output = renderInitTerminal(result, 90)
    expect(output).toContain('crust init — apps/web')
    expect(output).toContain('a route became less static')
    expect(output).toContain('FILES')
    expect(output).toContain('.perf/budgets.json')
    expect(output).toContain('NEXT')
    expect(output).toContain('force-dynamic')
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(90)
  })
})
