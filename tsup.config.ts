import { defineConfig } from 'tsup'

export default defineConfig({
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
