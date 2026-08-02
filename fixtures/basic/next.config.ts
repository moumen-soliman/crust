import type { NextConfig } from 'next'

// One fixture, several builds. CRUST_FIXTURE_MODE selects the rule set and
// bundler, each into its own distDir so all artifact sets survive side by side.
const mode = process.env.CRUST_FIXTURE_MODE ?? 'default'

const perMode: Record<string, Partial<NextConfig>> = {
  default: {},
  cc: { distDir: '.next-cc', cacheComponents: true },
  turbo: { distDir: '.next-turbo' },
  'turbo-cc': { distDir: '.next-turbo-cc', cacheComponents: true },
}

const config: NextConfig = {
  productionBrowserSourceMaps: true,
  ...perMode[mode],
}

export default config
