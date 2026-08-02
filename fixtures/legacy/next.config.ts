import type { NextConfig } from 'next'

// Next 15, no Cache Components: the inverted rule set. Static by default, and a
// dynamic API opts a route out loudly at build time rather than silently
// shrinking its shell. crust selects `legacy-ppr` here, and route segment
// config that Next 16 rejects under `cacheComponents` is legal - which is the
// whole reason this fixture exists separately from `basic`.
const mode = process.env.CRUST_FIXTURE_MODE ?? 'default'

const config: NextConfig = {
  productionBrowserSourceMaps: true,
  ...(mode === 'turbo' ? { distDir: '.next-turbo' } : {}),
}

export default config
