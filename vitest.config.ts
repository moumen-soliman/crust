import { defineConfig } from 'vitest/config'
import pkg from './package.json' with { type: 'json' }

// Mirrors the `define` in tsup.config.ts so `VERSION` resolves identically
// whether a test imports src/ or a smoke test runs the bundle from dist/.
export default defineConfig({
  define: {
    __CRUST_VERSION__: JSON.stringify(pkg.version),
  },
})
