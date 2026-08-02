import type { NextConfig } from 'next'

const config: NextConfig = {
  // The landing page is a crust subject as well as a crust advert: attribution
  // needs maps, and shipping them here costs nothing on a one-page site.
  productionBrowserSourceMaps: true,
}

export default config
