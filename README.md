<p align="center">
  <a href="https://crust.moumen.dev/">
    <img width="80" height="80" alt="crust" src="https://crust.moumen.dev/icon.svg" />
  </a>
</p>

<h1 align="center">crust</h1>

<p align="center">
  <strong>Know what became slower before it merges.</strong> crust analyzes production builds of
  Next.js App Router projects, explains why each route is static, partial, ISR, or dynamic, and
  compares snapshots to identify the component, import, and source line behind a regression.
</p>

<p align="center">
  <a href="https://docs.crust.moumen.dev/docs/quickstart">Get started</a> ·
  <a href="https://docs.crust.moumen.dev/">Documentation</a> ·
  <a href="https://github.com/moumen-soliman/crust/issues/new">Report a bug</a> ·
  <a href="https://github.com/moumen-soliman/crust/issues/new">Request a feature</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/moumen-soliman/crust?label=license&logo=github" alt="License" /></a>
  <a href="https://github.com/moumen-soliman/crust/actions/workflows/ci.yml"><img src="https://github.com/moumen-soliman/crust/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/moumen-soliman/crust/issues"><img src="https://img.shields.io/github/issues/moumen-soliman/crust" alt="Issues" /></a>
  <a href="https://www.npmjs.com/package/@moumensoliman/crust"><img src="https://img.shields.io/npm/v/@moumensoliman/crust.svg" alt="npm" /></a>
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="Status: pre-alpha" />
</p>

> The crust is what ships instantly. `crust` tells you what is in it, what fell out, why, and when.

**Status: pre-alpha.** The snapshot format, CLI output, and package API can still change.

## Features

- **Production-build analysis** - reads `.next` output instead of measuring unminified, HMR-heavy
  development builds.
- **Route explanations** - reports static, partial, ISR, dynamic, and route-handler modes with the
  API or cache decision that produced them.
- **Static-shell composition** - predicts the shell from source, verifies it against emitted HTML,
  and names the component and call site behind each hole.
- **Bundle attribution** - maps route bytes to first-party modules and dependencies through source
  maps, with separate webpack and Turbopack adapters.
- **Regression blame** - compares builds and identifies rendering-mode drops, cache regressions,
  shell shrinkage, and first-load growth.
- **CI enforcement** - fails strict regressions without configuration and supports explicit size,
  growth, and shell-ratio budgets.
- **Durable history** - stores one snapshot per build and can synchronize baselines through an
  orphan `perf-history` branch.
- **Reports without a service** - produces a self-contained HTML report and an optional in-app
  panel. No account or hosted dashboard is required.

**Next DevTools explains the current page. crust explains what became worse, why, and whether the
PR should merge.**

`@next/bundle-analyzer` has no history. Speed Insights has no source attribution. size-limit tools
do not understand routes or React Server Component boundaries. Next's build output can say that a
route is partially prerendered, but not which deep import caused its shell to shrink.

The in-app panel, runtime collector, ingest endpoint, synthetic runner, and OpenTelemetry spans are
deliberately secondary. The core workflow needs only source code and a production build.

## Requirements

- Next.js 15 or 16
- App Router (hybrid projects are supported, but Pages Router routes are not measured)
- webpack or Turbopack
- Node.js 20+
- A completed production build

Outside the supported Next.js range crust refuses to run instead of interpreting unverified build
artifacts.

## Install

Install crust as a development dependency so local and CI runs use the same version:

```bash
npm install --save-dev @moumensoliman/crust
```

```bash
pnpm add --save-dev @moumensoliman/crust
```

Or run it without adding a dependency:

```bash
npx @moumensoliman/crust analyze
```

The npm package is `@moumensoliman/crust`; the installed executable remains `crust`. Do not install the
unscoped `crust` package-it is unrelated. Playwright is an optional peer dependency needed only by
`crust synthetic`.

## Quick start

crust reads the output of a **production build**. Run one first - it refuses to measure
`next dev`, because dev numbers are unminified, unbundled and HMR-laden.

```bash
next build
npx @moumensoliman/crust analyze
```

The first thing it prints is the three things worth fixing, each with the call site and what to do
about it - not a wall of routes:

```
crust cfdcf50068722687  next 16.2.12 · webpack · 3 routes

Fix first

  1. /dashboard only 39% of this route is in the static shell
     ↳ cookies() at app/dashboard/page.tsx:18 - in <Theme>
     → <Theme> is postponed by that call. Cache it, or accept the hole if the data must be per-request.

  2. /products/[slug] only 45% of this route is in the static shell
     ↳ uncached fetch at lib/http.ts:3 - in <ProductGallery>
     → Add `use cache` above that read to pull <ProductGallery> back into the shell.

  3. / 543 kB of JavaScript on first load
     ↳ 296 kB of it (55%) could not be traced to any source
     → Source maps are on and these bytes still map to no first-party file, so they are
       framework or vendor internals. There is no import here to remove.

Route              First load   Shell  Mode
/                    543.2 kB    100%  static
/dashboard           527.4 kB     39%  partial
                    ↳ cookies() at app/dashboard/page.tsx:18
                    ✂ <Theme> - cookies() at app/dashboard/page.tsx:18
/products/[slug]     543.2 kB     45%  partial
```

Then, after a change:

```bash
next build
npx @moumensoliman/crust diff main
```

```
crust diff  cfdcf50068722687 -> 4a80239769ea8b93

/products/[slug] ▼  543.2 kB  -
    static -> partial
    shell 100% -> 45%
    cause: uncached fetch at lib/http.ts:3
    introduced by <ProductGallery>
```

That is the point. No build error was produced and not one byte moved - a `use cache` directive was
removed three call frames below the page, and 55% of the route stopped being static.

### Module attribution needs source maps

Route totals and shell analysis work out of the box. Blaming a specific *file* for those bytes
needs source maps in the production build:

```ts
// next.config.ts
export default { productionBrowserSourceMaps: true }
```

Without it crust still reports route sizes and shell composition, and says plainly that
attribution is unavailable rather than guessing. Turn it on in a dedicated analyze build if you
don't want maps in production.

### Seeing it visually

A self-contained HTML report - no integration, no server, one file you can open or attach to a PR:

```bash
npx @moumensoliman/crust report --open
```

### CI

```bash
npx @moumensoliman/crust ci main --comment comment.md
```

Exits non-zero and writes a PR comment. **Regressions are enforced with no configuration at all**,
as soon as a baseline snapshot exists:

- a route's rendering mode dropped (`static → partial`, `static → isr`, anything → `dynamic`)
- a read that was cached stopped being cached
- a route that emitted a static shell stopped emitting one

Those need no threshold - they are a strict downgrade against your own previous build. Only the
direction is judged, and only when it is certain. A check that fails on a guess is a check that gets
switched off, so no delta-based regression is enforced when the comparison itself is in doubt:

- if either side of the comparison is `unknown`, the change is reported and not failed
- if the two builds are not comparable at all - a different bundler, a different Next major, a
  different snapshot schema - no regression check runs, and the comment says so instead of
  attributing a difference it cannot attribute
- a newly added route is never a regression; there is no baseline for it to be worse than

Ceilings still apply in all three cases, because they describe a single build rather than a change.

The comment leads with the one route that got worst, and stays quiet about everything else:

```markdown
### crust: `/products/[slug]` is no longer static

**`/products/[slug]`**
- rendering: **static → partial**
- static shell: **100% → 45%**
- Cause: `uncached fetch at lib/http.ts:3`
- Introduced by: `<ProductGallery>`
```

*Ceilings*, unlike regressions, cannot be guessed for someone else's app, so they do nothing until
`.perf/budgets.json` names a number:

```json
{
  "defaultFirstLoadBytes": 250000,
  "firstLoadBytes": { "/products/[slug]": 180000 },
  "maxGrowth": 0.05,
  "defaultMinShellRatio": 0.6,
  "allowRegression": ["/admin/[...slug]"]
}
```

`allowRegression` is the escape hatch for a downgrade that was the point of the PR. It is a list of
routes rather than a global switch, so exempting one page cannot quietly exempt the rest of the app,
and it exempts only the zero-config rules above - a `maxGrowth` or `firstLoadBytes` budget is a
number you wrote down, and it keeps applying.

Both axes are covered on purpose: a check that only guards bytes will happily pass a PR that
silently halved your static shell.

Snapshots live in `.perf/` (one file per build - no merge conflicts) and sync through an orphan
`perf-history` branch so a fresh CI checkout has a baseline:

```bash
npx @moumensoliman/crust history fetch
npx @moumensoliman/crust history push
```

The bundled GitHub Action ([action/action.yml](action/action.yml)) does both, posts the comment,
and updates it in place on every push. Fork PRs get the comment but skip the push - their token is
read-only on the base repo, by design. `npx @moumensoliman/crust prune` applies the retention ladder: the newest
50 builds at full fidelity, then one per commit, then module detail dropped after 90 days; route
totals and shell ratios are kept forever.

## Command reference

| Command | Purpose |
|---|---|
| `crust analyze` | Analyze a production build, print prioritized findings, and save a snapshot |
| `crust diff [ref]` | Compare the current build with a build id, Git ref, branch, or ancestor |
| `crust ci [ref]` | Enforce regressions and budgets; optionally write a PR comment |
| `crust report` | Generate a self-contained HTML report |
| `crust manifest` | Generate the data consumed by the optional in-app panel |
| `crust history fetch` | Restore snapshots from the `perf-history` branch |
| `crust history push` | Publish snapshots to the `perf-history` branch |
| `crust prune` | Apply the snapshot-retention policy |
| `crust list` | List saved snapshots |
| `crust synthetic` | Measure routes on a running deployment with pinned Playwright throttling |

Every build command accepts `--cwd <dir>` for monorepos and `--dist-dir <dir>` for a custom Next.js
output directory. See the [complete CLI reference](https://docs.crust.moumen.dev/docs/reference/cli).

## Beyond the build

Everything above works from build output alone, and that is the part to trust first. What follows
observes a running app. It is genuinely useful and genuinely secondary - none of it is needed for
the analyzer or the CI check, and it is listed last on purpose.

### The in-app panel

Run the report **inside your app** as a floating panel. Write the manifest where the app can fetch
it, then mount the widget:

```bash
npx @moumensoliman/crust manifest --out public/crust-manifest.json
```

```tsx
// components/CrustPanel.tsx
'use client'

import { useEffect } from 'react'

export function CrustPanel() {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_CRUST) return
    let dispose: (() => void) | undefined
    import('@moumensoliman/crust/widget').then((m) => {
      dispose = m.mountCrustWidget()
    })
    return () => dispose?.()
  }, [])

  return null
}
```

Render `<CrustPanel />` in your root layout and build with the gate on:

```bash
NEXT_PUBLIC_CRUST=1 next build
```

The gate is checked before the dynamic `import()`, so with the variable unset the bundler drops the
widget entirely - it is never in your production bundle. The panel renders in a shadow root, so it
cannot restyle your app and your CSS cannot break it, and the manifest is only fetched when you
first open it, so it does not move the numbers it is reporting.

**The manifest lists every route, source path and component name in your app.** Generate it in
analyze builds only, never in the build you deploy.

### Runtime measurement

The collector observes real visits - Web Vitals via `PerformanceObserver`, long animation frames,
an image audit, and the streaming waterfall (when each Suspense hole actually filled):

```tsx
import { startCollector } from '@moumensoliman/crust/collector'

startCollector() // behind the same NEXT_PUBLIC_CRUST gate as the widget
```

The widget shows the live values for the current page. The streaming view sits behind a capability
check and reports "unavailable on this Next version" rather than breaking when internals move.

On staging, beacon samples to a write-only, authenticated, rate-limited endpoint:

```ts
// app/api/__crust/ingest/route.ts
import { createIngestHandler } from '@moumensoliman/crust/ingest'

export const POST = createIngestHandler({ secret: process.env.CRUST_INGEST_SECRET! })
```

And measure synthetically with pinned throttling (needs Playwright, an optional peer):

```bash
npx @moumensoliman/crust synthetic https://staging.example.com / /products/1 --cpu 4 --network fast-3g
```

The first iteration is discarded (cold start), the median is reported, and runs on different
machines are never merged into one trend line. Staging numbers are labeled "vs. previous build" -
never "is this fast" - because a seeded staging database is a fraction of production's size.

### Server spans

Minimal by design - most teams' APM already covers this. `crust/otel` exports a span processor
that plugs into `instrumentation.ts` (a supported API; crust never patches server internals) and
aggregates render and fetch time by route:

```ts
import { registerOTel } from '@vercel/otel'
import { CrustSpanAggregator } from '@moumensoliman/crust/otel'

export function register() {
  registerOTel({ serviceName: 'my-app', spanProcessors: [new CrustSpanAggregator()] })
}
```

## Escape hatches

Two optional JSON files in `.perf/`, for the tail the analyzer cannot resolve:

- `aliases.json` - `{ "app/old/page.tsx": "app/new/page.tsx" }` stitches a moved route back onto
  its history.
- `overrides.json` - `{ "@weird/alias": "packages/ui/src/index.ts" }` answers import specifiers no
  resolver can settle.

## How it works

### Architecture

<p align="center">
  <img src="https://crust.moumen.dev/crust-architecture.svg" alt="crust architecture: production source and build artifacts become a comparable snapshot, findings, regression blame, CI checks, and reports" />
</p>

The source graph supplies the **why**; production artifacts supply the **what**. crust joins both
into one snapshot, then compares that snapshot only with a compatible baseline. Runtime tooling is
optional and does not participate in the core build verdict.

### What happens on a pull request

<p align="center">
  <img src="https://crust.moumen.dev/crust-pull-request.svg" alt="crust pull request workflow from production build through baseline comparison, PR comment, snapshot publication, and exit code" />
</p>

The decision rule is intentionally conservative:

<p align="center">
  <img src="https://crust.moumen.dev/crust-decision-rule.svg" alt="crust decision rule: compare only compatible baselines, never fail on unknown evidence, and enforce proven regressions" />
</p>

1. **Detect the build** - crust reads the resolved Next.js version, bundler, route manifests,
   prerender metadata, client-reference manifests, and emitted shell HTML.
2. **Build the source graph** - imports, exports, server/client boundaries, dynamic APIs, fetch
   caching, Suspense boundaries, and `use cache` directives are extracted without executing the
   application.
3. **Attribute bytes** - each route's chunks are mapped to workspace files and packages. Any byte
   that cannot be proven is recorded as unattributed.
4. **Predict and verify the shell** - source analysis explains *why* a component is postponed;
   emitted HTML verifies *what* the production build actually prerendered.
5. **Record identity** - Git state, lockfile, Next version, Node major, bundler, and resolved config
   form a build id so unrelated environments are not merged into one trend.
6. **Compare and enforce** - comparable snapshots produce route-level deltas, blame, automatic
   regression checks, and optional project-defined ceilings.

## Non-goals

These are permanent. They are written here before the first user arrives, on purpose.

- **Not a runtime APM.** No error tracking, no distributed tracing, no alerting.
- **Not a Lighthouse or PageSpeed replacement.**
- **Not multi-framework.** Next.js App Router only. Pages Router is detect-and-warn.
- **Not a hosted service.** No accounts, no SaaS dashboard.
- **Not a bundler.** It reads build output; it never changes how your app builds in production.
- **No config file** until three separate people request the same option. Zero-config is a feature,
  and config surface is permanent API you cannot remove.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Measurement target | Production builds only | Dev numbers are unminified, unbundled, HMR-laden fiction |
| Dev mode | Static map only, never timings | Better to show nothing than wrong numbers |
| Supported range | Two Next majors, both bundlers | Fail loudly outside it rather than emit wrong output |
| Package shape | One CLI with optional subpath exports | `/widget`, `/collector`, `/ingest`, `/otel` |
| Snapshot store | One file per record + derived SQLite index | Per-file avoids git conflicts; the index is rebuildable |
| Prod safety | Build-time env gate, never a runtime flag | A runtime `if` still ships the code and the manifest |
| Unknowns | Report `unknown`, never guess | A predictor that guesses wrong destroys trust in the whole tool |

## Support

Next.js 15 and 16, webpack and Turbopack. Outside that range the tool refuses to run rather than
emit numbers it can't stand behind. Best-effort maintenance; issues triaged weekly.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The real-build tests use the apps under `fixtures/`. Build output is intentionally not committed.
The Phase 0 spike and its measured webpack/Turbopack attribution results are documented in
[`docs/phase-0-findings.md`](docs/phase-0-findings.md).

## License

[MIT](LICENSE) © Moumen Soliman.
