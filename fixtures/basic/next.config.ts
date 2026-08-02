import type { NextConfig } from 'next'

// One fixture, several builds. CRUST_FIXTURE_MODE selects the rule set and
// bundler, each into its own distDir so all artifact sets survive side by side.
//
// Route segment config that `cacheComponents` rejects - `dynamic`, `revalidate`,
// `runtime` - cannot live here, because every mode shares this app directory and
// one illegal export fails the cc build. Those shapes are in fixtures/legacy.
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
