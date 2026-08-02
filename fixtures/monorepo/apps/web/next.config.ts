import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const mode = process.env.CRUST_FIXTURE_MODE ?? 'default'
const here = dirname(fileURLToPath(import.meta.url))
// packages/* live outside the app directory, so the root both bundlers resolve
// against is the workspace root, not this app.
// The real pnpm workspace root is the crust repo — that is where node_modules and
// pnpm-workspace.yaml live, and both bundlers anchor source paths there. This is
// the realistic monorepo shape: sources sit several levels below the root.
const workspaceRoot = resolve(here, '../../../..')

const perMode: Record<string, Partial<NextConfig>> = {
  default: {},
  cc: { distDir: '.next-cc', cacheComponents: true },
  turbo: { distDir: '.next-turbo' },
}

const config: NextConfig = {
  productionBrowserSourceMaps: true,
  // Workspace packages ship TypeScript source, so Next has to compile them.
  transpilePackages: ['@fixture/ui', '@fixture/icons'],
  // Without this the inferred root is the crust repo and Turbopack anchors every
  // source path there — one of the Phase 0 findings.
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  ...perMode[mode],
}

export default config
