import { DOCS, GITHUB, SiteFooter, SiteNav } from './chrome'
import { CodePanel, type CodeTab } from './code-panel'

const TABS: CodeTab[] = [
  {
    name: 'diff',
    lines: [
      <>
        <span className="text-muted">$</span> next build <span className="text-muted">&amp;&amp;</span> npx
        @moumensoliman/crust diff main
      </>,
      <></>,
      <>
        crust diff <span className="text-muted">cfdcf500 → 4a802397</span>
      </>,
      <></>,
      <span className="text-red">/products/[slug] ▼</span>,
      <>
        {'  '}rendering <span className="text-red">static → partial</span>
      </>,
      <>
        {'  '}shell <span className="text-red">100% → 45%</span>
      </>,
      <>
        {'  '}cause <span className="text-green">uncached fetch at lib/http.ts:3</span>
      </>,
      <>
        {'  '}introduced by <span className="text-blue">&lt;ProductGallery&gt;</span>
      </>,
      <></>,
      <span className="text-red">1 failing check · exit 1</span>,
    ],
  },
  {
    name: 'analyze',
    lines: [
      <>
        crust <span className="text-muted">4a802397 · next 16.2 · turbopack</span>
      </>,
      <span className="text-green">92% confidence · 3/3 routes classified</span>,
      <></>,
      <span className="text-blue">Fix first</span>,
      <></>,
      <>1. /products/[slug]</>,
      <span className="text-red">{'   only 45% is in the static shell'}</span>,
      <span className="text-muted">{'   ↳ uncached fetch at lib/http.ts:3'}</span>,
      <span className="text-green">{'   → add `use cache` above that read'}</span>,
      <></>,
      <span className="text-muted">Route              First load  Shell  Mode</span>,
      <>/                    143.2 kB   100%  static</>,
      <>/products/[slug]     168.4 kB    45%  partial</>,
    ],
  },
  {
    name: 'budgets.json',
    lines: [
      <>{'{'}</>,
      <>
        {'  '}
        <span className="text-blue">&quot;defaultFirstLoadBytes&quot;</span>: <span className="text-amber">250000</span>,
      </>,
      <>
        {'  '}
        <span className="text-blue">&quot;maxGrowth&quot;</span>: <span className="text-amber">0.05</span>,
      </>,
      <>
        {'  '}
        <span className="text-blue">&quot;defaultMinShellRatio&quot;</span>: <span className="text-amber">0.6</span>,
      </>,
      <>
        {'  '}
        <span className="text-blue">&quot;allowRegression&quot;</span>: [
      </>,
      <>
        {'    '}
        <span className="text-green">&quot;/admin/[...slug]&quot;</span>
      </>,
      <>{'  ]'}</>,
      <>{'}'}</>,
      <></>,
      <span className="text-muted">{'// strict regressions need no config'}</span>,
      <span className="text-muted">{'// ceilings stay yours to choose'}</span>,
    ],
  },
]

const WORKFLOW = [
  {
    title: '1. Build production',
    body: 'crust reads the .next output you actually ship. It refuses to turn HMR-heavy development output into performance claims.',
  },
  {
    title: '2. Join source to artifacts',
    body: 'Route manifests, chunks, source maps, component imports, cache directives, Suspense boundaries and shell HTML become one model.',
  },
  {
    title: '3. Explain each route',
    body: 'See rendering mode, first-load JavaScript, shell composition, client boundaries and the source reason behind each dynamic edge.',
  },
  {
    title: '4. Store a real identity',
    body: 'Git state, lockfile, Next version, Node major, bundler and resolved config form a build id, so unlike builds never share a trend.',
  },
  {
    title: '5. Compare safely',
    body: 'Only compatible builds produce deltas. A bundler, Next major or schema change stops comparison before framework noise becomes blame.',
  },
  {
    title: '6. Enforce the result',
    body: 'One PR comment leads with the worst proven regression. CI fails on strict direction or a project-defined ceiling-not on a guess.',
  },
]

const FEATURES = [
  {
    title: 'Route explanations',
    body: 'Why every page is static, ISR, partial, dynamic or a route handler, with the API, read or configuration that decided it.',
  },
  {
    title: 'Static shell composition',
    body: 'What is prerendered, what is postponed, and the exact call site that pushed each component out of the shell.',
  },
  {
    title: 'Route-level attribution',
    body: 'First-load JavaScript traced through source maps to first-party files and packages across webpack and Turbopack.',
  },
  {
    title: 'Regression blame',
    body: 'Rendering mode, cache reasons, shell ratio and bytes compared together, with the strongest source evidence selected as the cause.',
  },
  {
    title: 'CI with useful defaults',
    body: 'Mode drops, newly uncached reads and a vanished shell fail without configuration. Byte and ratio ceilings remain yours to choose.',
  },
  {
    title: 'Durable history',
    body: 'Conflict-free snapshots on an orphan branch, with route identity that survives URL changes and squash-merged commits.',
  },
  {
    title: 'Complete cause chains',
    body: 'Follow a route through components, bindings and imports to the exact call site, with verified, inferred or unknown evidence.',
  },
  {
    title: 'Shared causes',
    body: 'Group layouts, client boundaries, barrels, packages and call sites once with every route they affect.',
  },
  {
    title: 'Actionable client cost',
    body: 'Measure complete client-boundary subtrees and the modules a barrel import uniquely drags into a route.',
  },
  {
    title: 'Measurable confidence',
    body: 'See classified routes, measured shells, attributed bytes and conservative fallbacks behind every confidence line.',
  },
]

const CERTAINTY = [
  ['Unknown is a result.', 'If a cause cannot be established, crust reports unknown instead of manufacturing a plausible answer.'],
  ['A new route is not a regression.', 'There was no baseline to become worse than; absolute budgets can still apply.'],
  ['Unlike builds are not compared.', 'Bundler, Next major and snapshot schema must agree before a delta can fail CI.'],
  ['Tiny movement stays quiet.', 'Exact totals are stored, but content-hash-sized byte changes do not become review noise.'],
  ['Strict direction is automatic.', 'A static route becoming dynamic is a fact against your baseline and needs no threshold.'],
  ['Product limits are explicit.', 'First-load ceilings, growth percentages and shell floors remain in your budgets file.'],
]

const SECONDARY = [
  {
    title: 'Self-contained report',
    body: 'One searchable HTML file with route filters, grouping, cause chains, module attribution and shell composition. No server or account.',
  },
  {
    title: 'Optional in-app panel',
    body: 'Route map, Web Vitals, long animation frames, image audit and streaming waterfall behind a build-time gate.',
  },
  {
    title: 'Staging measurements',
    body: 'Optional synthetic runs, a write-only ingest endpoint and compact route-level OpenTelemetry aggregation.',
  },
]

const NON_GOALS = [
  ['Not Next DevTools.', 'DevTools explains the current page. crust explains what became worse across production builds.'],
  ['Not a runtime APM.', 'No error tracking, distributed tracing or alerting platform.'],
  ['Not a Lighthouse replacement.', 'It measures what your build produced, not a generic lab score.'],
  ['Not multi-framework.', 'Next.js App Router only. Pages Router is detect-and-warn.'],
  ['Not a hosted service.', 'No accounts or SaaS dashboard. Your snapshots stay in your repository.'],
  ['Not a bundler.', 'It reads build output and never changes how the application builds.'],
]

const btn =
  'inline-flex items-center justify-center gap-2 min-h-10 px-4 rounded-[7px] border border-transparent text-small font-medium no-underline cursor-pointer font-[inherit] transition-[scale,opacity,background-color,border-color,color] duration-[140ms] ease-crust active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 max-[520px]:w-full motion-reduce:active:scale-100'
const btnPrimary = `${btn} bg-fg text-bg hover:opacity-[0.86]`
const btnCmd = `${btn} border-border bg-surface text-muted font-mono text-meta hover:text-fg hover:border-faint`
const secHead =
  'flex flex-wrap items-baseline gap-3.5 border-b border-border px-pad py-[26px]'
const grid =
  'grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-px border-t border-border bg-border'
const gridCell = 'bg-bg px-pad py-[22px]'
const nogoRow =
  'border-b border-border py-4 text-small text-muted text-pretty last:border-b-0'

export default function Home() {
  return (
    <div className="mx-auto min-h-screen max-w-shell border-x border-border">
      <SiteNav />

      <header className="grid items-center gap-[clamp(28px,5vw,56px)] px-pad py-[clamp(44px,7vw,88px)] max-[900px]:grid-cols-1 min-[901px]:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div>
          <div className="mb-7 flex gap-2.5 text-micro uppercase tracking-[0.06em] text-faint">
            <span className="after:text-border after:content-['_/'] last:after:content-none">
              Next 15 &amp; 16
            </span>
            <span className="after:text-border after:content-['_/'] last:after:content-none">webpack</span>
            <span className="after:text-border after:content-['_/'] last:after:content-none">Turbopack</span>
          </div>
          <h1 className="m-0 text-h1 font-medium leading-[1.12] tracking-[-0.028em] text-balance">
            Know what became slower,
            <br />
            and{' '}
            <span className="underline decoration-faint decoration-dotted decoration-1 underline-offset-[6px]">
              the source line that did it
            </span>
          </h1>
          <p className="mt-5 max-w-[46ch] text-small leading-[1.65] text-muted text-pretty">
            crust explains why every App Router page is static, partial, ISR or dynamic-then keeps
            enough build history to tell you what changed and whether the pull request should merge.
          </p>
          <div className="mt-[30px] flex flex-wrap gap-2.5 max-[520px]:flex-col">
            <a className={btnPrimary} href={`${DOCS}/docs/quickstart`}>
              Read the quickstart
            </a>
            <a className={btnCmd} href="https://www.npmjs.com/package/@moumensoliman/crust">
              <span className="text-faint">›</span> npx @moumensoliman/crust analyze
            </a>
          </div>
        </div>
        <CodePanel tabs={TABS} />
      </header>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">
            The regression bundle budgets cannot see
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            No build error. No byte moved. The static shell still dropped from 100% to 45%.
          </p>
        </div>
        <div className="px-pad py-[clamp(28px,4vw,44px)]">
          <div className="grid gap-4 max-[900px]:grid-cols-1 min-[901px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
              <div className="flex items-center gap-2 border-b border-border px-[13px] py-[9px] text-micro uppercase tracking-[0.06em] text-faint">
                <span className="flex gap-[5px]">
                  <i className="block size-2 rounded-full bg-border" />
                  <i className="block size-2 rounded-full bg-border" />
                  <i className="block size-2 rounded-full bg-border" />
                </span>
                production build
              </div>
              <div className="overflow-x-auto px-[18px] pt-4 pb-5">
                <div className="grid min-w-0 grid-cols-[1fr_auto_auto_auto] items-center gap-x-3.5 gap-y-2.5 text-meta max-[520px]:min-w-[430px]">
                  <span className="text-micro uppercase tracking-[0.06em] text-faint">Route</span>
                  <span className="text-right text-micro uppercase tracking-[0.06em] text-faint">
                    First load
                  </span>
                  <span className="text-micro uppercase tracking-[0.06em] text-faint">Shell</span>
                  <span className="text-micro uppercase tracking-[0.06em] text-faint">Mode</span>

                  <span className="font-mono text-fg">/</span>
                  <span className="text-right text-muted tabular-nums">143.2 kB</span>
                  <span className="h-1 w-[62px] overflow-hidden rounded-sm bg-border">
                    <i className="block h-full rounded-sm bg-fg" style={{ width: '100%' }} />
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-muted before:block before:size-1.5 before:shrink-0 before:rounded-full before:bg-green">
                    static
                  </span>

                  <span className="font-mono text-fg">/products/[slug]</span>
                  <span className="text-right text-muted tabular-nums">168.4 kB</span>
                  <span className="h-1 w-[62px] overflow-hidden rounded-sm bg-border">
                    <i className="block h-full rounded-sm bg-red" style={{ width: '45%' }} />
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-muted before:block before:size-1.5 before:shrink-0 before:rounded-full before:bg-blue">
                    partial
                  </span>

                  <span className="font-mono text-fg">/dashboard</span>
                  <span className="text-right text-muted tabular-nums">152.7 kB</span>
                  <span className="h-1 w-[62px] overflow-hidden rounded-sm bg-border">
                    <i className="block h-full rounded-sm bg-red" style={{ width: '39%' }} />
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-muted before:block before:size-1.5 before:shrink-0 before:rounded-full before:bg-blue">
                    partial
                  </span>
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
              <div className="flex items-center gap-2 border-b border-border px-[13px] py-[9px] text-micro uppercase tracking-[0.06em] text-faint">
                Pull request
              </div>
              <div className="px-[18px] pt-4 pb-5 text-meta leading-[1.7]">
                <h4 className="mb-2.5 text-small font-[550] text-red">
                  crust: /products/[slug] is no longer static
                </h4>
                <div className="mb-2 flex gap-2 text-muted text-pretty">
                  <span className="mt-2 block size-[5px] shrink-0 rounded-full bg-faint" />
                  <span>
                    rendering: <b className="text-fg">static → partial</b>
                    <br />
                    static shell: <b className="text-red">100% → 45%</b>
                  </span>
                </div>
                <div className="mb-2 flex gap-2 text-muted text-pretty">
                  <span className="mt-2 block size-[5px] shrink-0 rounded-full bg-faint" />
                  <span>
                    Cause:{' '}
                    <code className="rounded px-[5px] py-px text-micro text-fg bg-raised">
                      uncached fetch at lib/http.ts:3
                    </code>
                    <br />
                    Introduced by:{' '}
                    <code className="rounded px-[5px] py-px text-micro text-fg bg-raised">
                      &lt;ProductGallery&gt;
                    </code>
                  </span>
                </div>
                <div className="mb-2 flex gap-2 text-muted text-pretty">
                  <span className="mt-2 block size-[5px] shrink-0 rounded-full bg-faint" />
                  <span>
                    <span className="text-green">verified evidence</span>
                    {' · '}
                    <span className="text-red">1 failing check · exit 1</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <p className="mt-5 max-w-[70ch] text-small leading-[1.65] text-muted text-pretty">
            A <code className="font-mono">use cache</code> directive was removed three call frames
            below the page. Conventional size checks passed because the JavaScript was identical.
            crust joined source analysis to the emitted shell and named both the call site and the
            component that left it.
          </p>
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">How it works</h2>
          <p className="m-0 text-small text-muted text-pretty">
            Source explains why. Production artifacts prove what. History reveals what changed.
          </p>
        </div>
        <div className={grid}>
          {WORKFLOW.map((step) => (
            <div key={step.title} className={gridCell}>
              <h3 className="mb-1.5 text-small font-[550] tracking-[-0.006em]">{step.title}</h3>
              <p className="m-0 text-meta leading-[1.65] text-muted text-pretty">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">
            One route-level model
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            Rendering, caching, shell composition and bundles are evidence for the same verdict.
          </p>
        </div>
        <div className={grid}>
          {FEATURES.map((feature) => (
            <div key={feature.title} className={gridCell}>
              <h3 className="mb-1.5 text-small font-[550] tracking-[-0.006em]">{feature.title}</h3>
              <p className="m-0 text-meta leading-[1.65] text-muted text-pretty">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">
            How crust decides
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            A check that fails on guesses gets switched off.
          </p>
        </div>
        <div className="px-pad py-[clamp(28px,4vw,44px)]">
          <div>
            {CERTAINTY.map(([title, body]) => (
              <div key={title} className={nogoRow}>
                <b className="font-[550] text-fg">{title}</b> {body}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">Beyond the build</h2>
          <p className="m-0 text-small text-muted text-pretty">
            Useful secondary surfaces. None are required for analyze, diff or CI.
          </p>
        </div>
        <div className={grid}>
          {SECONDARY.map((feature) => (
            <div key={feature.title} className={gridCell}>
              <h3 className="mb-1.5 text-small font-[550] tracking-[-0.006em]">{feature.title}</h3>
              <p className="m-0 text-meta leading-[1.65] text-muted text-pretty">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">What it is not</h2>
          <p className="m-0 text-small text-muted text-pretty">
            The boundary keeps the core small enough to trust.
          </p>
        </div>
        <div className="px-pad py-[clamp(28px,4vw,44px)]">
          <div>
            {NON_GOALS.map(([title, body]) => (
              <div key={title} className={nogoRow}>
                <b className="font-[550] text-fg">{title}</b> {body}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border px-pad py-[clamp(48px,7vw,88px)] text-center">
        <h2 className="mb-3 text-h2 font-medium tracking-[-0.02em] text-balance">
          Start with one production build
        </h2>
        <p className="mx-auto max-w-[44ch] text-small text-muted text-pretty">
          Explain every route now. Add a baseline, and the next pull request has something honest to
          compare against.
        </p>
        <div className="mt-[30px] flex flex-wrap justify-center gap-2.5 max-[520px]:flex-col">
          <a className={btnPrimary} href={`${DOCS}/docs/quickstart`}>
            Get started
          </a>
          <a className={btnCmd} href={`${DOCS}/docs/reference/cli`}>
            <span className="text-faint">›</span> npx @moumensoliman/crust report --open
          </a>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
