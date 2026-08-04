import { DOCS, GITHUB, SiteFooter, SiteNav } from './chrome'
import { BlastDiagram, ChainDiagram, DiffDiagram, SnapshotDiagram } from './diagrams'
import { HeroPanel, type CodeTab } from './hero-panel'

const TABS: CodeTab[] = [
  {
    name: 'diff',
    lines: [
      <>
        <span className="text-muted">$</span> npx @moumensoliman/crust diff main feature
      </>,
      <></>,
      <>
        <span className="text-red">BLOCK</span> <span className="text-muted">· attribution 94%</span>
      </>,
      <></>,
      <span className="text-red">/products/[slug] is no longer static</span>,
      <>
        {'  '}rendering <span className="text-red">static → partial</span> <span className="text-muted">· shell 100% → 45%</span>
      </>,
      <>
        {'  '}at <span className="text-blue">lib/http.ts:3</span> in <span className="text-blue">&lt;ProductGallery&gt;</span>
      </>,
      <>
        {'  '}→ <span className="text-green">cache that read and the route can prerender again</span>
      </>,
      <></>,
      <span className="text-blue">CAUSES</span>,
      <>
        {'  '}date-fns added <span className="text-red">+48.2 kB</span> on /checkout, +8 more
      </>,
      <>  &lt;AnalyticsProvider&gt; became client <span className="text-red">+82.0 kB</span> on 3 routes</>,
    ],
  },
  {
    name: 'analyze',
    lines: [
      <>
        crust <span className="text-muted">4a802397 · next 16.2 · turbopack</span>
      </>,
      <span className="text-green">92% confidence · 14/14 routes classified</span>,
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
    title: '1. Build what ships',
    body: 'crust reads completed .next output, not HMR-heavy development bundles or a generic lab score.',
  },
  {
    title: '2. Record the evidence',
    body: 'Route modes, shell HTML, chunks, source maps, cache decisions and source relationships become one compatible snapshot.',
  },
  {
    title: '3. Choose two builds',
    body: 'Compare branches, commits, tags or build ids without checking either ref out or rebuilding it.',
  },
  {
    title: '4. Get the decision first',
    body: 'BLOCK, REVIEW, CLEAR or CANNOT DECIDE leads the output, followed by the few changes that drove it.',
  },
  {
    title: '5. Follow cause to source',
    body: 'One package, client boundary, barrel or call site is stated once with its blast radius and strongest source location.',
  },
  {
    title: '6. Enforce what is proven',
    body: 'CI blocks strict regressions and your chosen ceilings, records the finding, and never turns missing evidence into a guess.',
  },
]

const FEATURES = [
  {
    title: 'Two-build comparison',
    body: 'Compare a base and head by branch, tag, commit or build id. Both sides come from stored production evidence.',
  },
  {
    title: 'Decision before inventory',
    body: 'The verdict, worst changes, evidence coverage and likely next action appear before route tables and raw totals.',
  },
  {
    title: 'Rendering regressions',
    body: 'Catch a route becoming less static, losing cache coverage or shrinking its emitted shell even when bundle bytes do not move.',
  },
  {
    title: 'Client-cost regressions',
    body: 'Trace first-load growth to packages, complete client-boundary subtrees, barrel drag and first-party files.',
  },
  {
    title: 'One cause, every route',
    body: 'Group a provider, package, import style or call site once, then show every route sharing its blast radius.',
  },
  {
    title: 'Improvements included',
    body: 'See routes that became more static, regained caching or shed client JavaScript—not only what failed.',
  },
  {
    title: 'Complete cause chains',
    body: 'Follow route → component → binding → import → call site, with verified, inferred or unknown evidence.',
  },
  {
    title: 'CI with useful defaults',
    body: 'Mode drops, newly uncached reads and vanished shells fail without configuration. Size ceilings remain your decision.',
  },
  {
    title: 'Measured trust',
    body: 'Record whether authors agreed with each blocking finding and report the disagreement rate over reviewed findings.',
  },
  {
    title: 'Repository-owned history',
    body: 'Keep snapshots and findings on a conflict-free history branch. No account, upload or hosted dashboard is required.',
  },
]

const CERTAINTY = [
  ['Unknown is a result.', 'If a cause cannot be established, crust reports unknown instead of manufacturing a plausible answer.'],
  ['Coverage sits beside the verdict.', 'A correct byte delta with weak attribution never looks more certain than its evidence.'],
  ['A new route is not a regression.', 'There was no baseline to become worse than; absolute budgets can still apply.'],
  ['Unlike builds are not compared.', 'Bundler, Next major and snapshot schema must agree before a delta can fail CI.'],
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
  ['Not a one-build bundle explorer.', 'Those tools show what a build contains. crust decides what changed between builds and why.'],
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
            The production-build diff that helps you{' '}
            <span className="underline decoration-faint decoration-dotted decoration-1 underline-offset-[6px]">
              decide what can ship
            </span>
          </h1>
          <p className="mt-5 max-w-[46ch] text-small leading-[1.65] text-muted text-pretty">
            Compare two Next.js App Router production builds. crust leads with the decision, groups
            every affected route by cause, and traces regressions to the component, import and source
            line that introduced them.
          </p>
          <div className="mt-[30px] flex flex-wrap gap-2.5 max-[520px]:flex-col">
            <a className={btnPrimary} href={`${DOCS}/docs/quickstart`}>
              Read the quickstart
            </a>
            <a className={btnCmd} href="https://www.npmjs.com/package/@moumensoliman/crust">
              <span className="text-faint">›</span> npx @moumensoliman/crust diff main
            </a>
          </div>
        </div>
        <HeroPanel
          video={{ src: '/crust3.mp4', poster: '/crust3-poster.jpg', name: 'watch' }}
          tabs={TABS}
        />
      </header>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">
            Catch the regression a size budget cannot see
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            No build error. No byte growth. A route still fell from static to partial.
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
                  crust: BLOCK · /products/[slug] is no longer static
                </h4>
                <div className="mb-2 text-micro text-muted">attribution 94%</div>
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
                    Do this: <span className="text-green">cache that read so the route can prerender again</span>
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
            below the page. Conventional bundle checks passed because the JavaScript was identical.
            crust compared the emitted shells, followed the source chain, and named the edit that
            changed the merge decision.
          </p>

          {/* The paragraph above says "followed the source chain" and asks the
              reader to take the hops on trust. The drawing is the same claim
              with its links visible. */}
          <div className="mt-[clamp(28px,3.5vw,40px)]">
            <ChainDiagram />
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className={secHead}>
          <h2 className="m-0 text-h2 font-medium tracking-[-0.02em] text-balance">How it works</h2>
          <p className="m-0 text-small text-muted text-pretty">
            Production artifacts prove what changed. Source explains why. History makes it comparable.
          </p>
        </div>

        {/* Two halves of the same mechanism, in order: one build becomes a
            record, then any two records become a decision. Read together they
            answer the question the six steps below only answer in prose —
            where the base build comes from if nobody rebuilt it. */}
        <div className="grid gap-[clamp(32px,4vw,48px)] px-pad py-[clamp(28px,4vw,44px)]">
          {/* Grid items need `min-w-0` or the diagrams inside them widen the
              track rather than scrolling within it. */}
          <div className="min-w-0">
            <h3 className="mb-4 text-small font-[550] tracking-[-0.006em]">
              Every production build becomes one comparable record
            </h3>
            <SnapshotDiagram />
          </div>
          <div className="min-w-0">
            <h3 className="mb-4 text-small font-[550] tracking-[-0.006em]">
              Any two records become one decision
            </h3>
            <DiffDiagram />
          </div>
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
            One decision from every build signal
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            Rendering, caching, shell composition and client cost support the same verdict.
          </p>
        </div>

        {/* "One cause, every route" is a feature cell below. It is also the
            hardest claim on the page to picture, so it gets the drawing. */}
        <div className="px-pad py-[clamp(28px,4vw,44px)]">
          <BlastDiagram />
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
            Conservative enough to keep enabled
          </h2>
          <p className="m-0 text-small text-muted text-pretty">
            Missing evidence lowers confidence; it never becomes confident-looking blame.
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
          Give your next pull request a build diff
        </h2>
        <p className="mx-auto max-w-[44ch] text-small text-muted text-pretty">
          Initialize once, keep the snapshots in your repository, and let every later build answer
          what changed, why, and whether it should ship.
        </p>
        <div className="mt-[30px] flex flex-wrap justify-center gap-2.5 max-[520px]:flex-col">
          <a className={btnPrimary} href={`${DOCS}/docs/quickstart`}>
            Get started
          </a>
          <a className={btnCmd} href={`${DOCS}/docs/reference/cli`}>
            <span className="text-faint">›</span> npx @moumensoliman/crust init
          </a>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
