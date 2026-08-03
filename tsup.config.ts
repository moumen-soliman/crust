import { defineConfig } from 'tsup'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  // package.json is the single source of the tool version - see src/version.ts.
  define: {
    __CRUST_VERSION__: JSON.stringify(pkg.version),
  },
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    widget: 'src/widget.ts',
    collector: 'src/collector.ts',
    ingest: 'src/ingest.ts',
    otel: 'src/otel.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  splitting: false,
  sourcemap: true,
})
