import type { NextConfig } from 'next'

// Next 16.3, Instant Navigations. This fixture exists to pin the *declared*
// navigation axis, which is the only part of it a build artifact records.
//
// `basic` stays on 16.2.x on purpose - it is what proves the rendering axis on
// the version most users are on, and upgrading it in place would trade that
// coverage for this. So the two live side by side.
//
// `validationLevel` is set to a non-default value deliberately: Next resolves
// its own default into the config, so pinning `'manual-warning'` proves crust
// reads what the build actually said rather than reporting the default back.
//
// It is a *warning* level rather than an error level because the error levels
// fail the build on a broken `instant` contract. That is the correct behaviour
// and the reason crust cannot measure this axis - but a fixture whose job is to
// be analysed has to finish building first.
const config: NextConfig = {
  productionBrowserSourceMaps: true,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: { instantInsights: { validationLevel: 'manual-warning' } },
}

export default config
