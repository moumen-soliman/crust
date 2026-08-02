import { CodePanel, type CodeTab } from './code-panel'
import { Mark } from './mark'

const DOCS = 'https://docs.crust.moumen.dev'
const GITHUB = 'https://github.com/moumen-soliman/crust'

const TABS: CodeTab[] = [
  {
    name: 'diff',
    lines: [
      <>
        <span className="c-dim">$</span> next build <span className="c-dim">&amp;&amp;</span> npx @moumensoliman/crust diff main
      </>,
      <></>,
      <>
        crust diff <span className="c-dim">cfdcf500 → 4a802397</span>
      </>,
      <></>,
      <span className="c-red">/products/[slug] ▼</span>,
      <>
        {'  '}rendering <span className="c-red">static → partial</span>
      </>,
      <>
        {'  '}shell <span className="c-red">100% → 45%</span>
      </>,
      <>
        {'  '}cause <span className="c-str">uncached fetch at lib/http.ts:3</span>
      </>,
      <>
        {'  '}introduced by <span className="c-key">&lt;ProductGallery&gt;</span>
      </>,
      <></>,
      <span className="c-red">1 failing check · exit 1</span>,
    ],
  },
  {
    name: 'analyze',
    lines: [
      <>
        crust <span className="c-dim">4a802397 · next 16.2 · turbopack</span>
      </>,
      <></>,
      <span className="c-key">Fix first</span>,
      <></>,
      <>1. /products/[slug]</>,
      <span className="c-red">{'   only 45% is in the static shell'}</span>,
      <span className="c-dim">{'   ↳ uncached fetch at lib/http.ts:3'}</span>,
      <span className="c-str">{'   → add `use cache` above that read'}</span>,
      <></>,
      <span className="c-dim">Route              First load  Shell  Mode</span>,
      <>/                    143.2 kB   100%  static</>,
      <>/products/[slug]     168.4 kB    45%  partial</>,
    ],
  },
  {
    name: 'budgets.json',
    lines: [
      <>{'{'}</>,
      <>
        {'  '}<span className="c-key">&quot;defaultFirstLoadBytes&quot;</span>: <span className="c-num">250000</span>,
      </>,
      <>
        {'  '}<span className="c-key">&quot;maxGrowth&quot;</span>: <span className="c-num">0.05</span>,
      </>,
      <>
        {'  '}<span className="c-key">&quot;defaultMinShellRatio&quot;</span>: <span className="c-num">0.6</span>,
      </>,
      <>
        {'  '}<span className="c-key">&quot;allowRegression&quot;</span>: [
      </>,
      <>
        {'    '}<span className="c-str">&quot;/admin/[...slug]&quot;</span>
      </>,
      <>{'  ]'}</>,
      <>{'}'}</>,
      <></>,
      <span className="c-dim">{'// strict regressions need no config'}</span>,
      <span className="c-dim">{'// ceilings stay yours to choose'}</span>,
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
    body: 'One PR comment leads with the worst proven regression. CI fails on strict direction or a project-defined ceiling—not on a guess.',
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
    body: 'One HTML file with summary figures, route detail, module attribution and shell composition. No server or account.',
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

export default function Home() {
  return (
    <div className="shell">
      <nav className="nav pad">
        <a className="brand" href="/">
          <Mark size={17} />
          crust
        </a>
        <div className="nav-links">
          <a href={`${DOCS}/docs/quickstart`}>Quickstart</a>
          <a href={`${DOCS}/docs/concepts/regressions`}>How it thinks</a>
          <a href={`${DOCS}/docs/reference/cli`}>CLI</a>
        </div>
        <a className="nav-right" href={GITHUB}>
          GitHub
        </a>
      </nav>

      <header className="hero pad">
        <div>
          <div className="crumbs">
            <span>Next 15 &amp; 16</span>
            <span>webpack</span>
            <span>Turbopack</span>
          </div>
          <h1>
            Know what became slower,
            <br />
            and <span className="underlined">the source line that did it</span>
          </h1>
          <p className="lead">
            crust explains why every App Router page is static, partial, ISR or dynamic—then keeps
            enough build history to tell you what changed and whether the pull request should merge.
          </p>
          <div className="actions">
            <a className="btn btn-primary" href={`${DOCS}/docs/quickstart`}>
              Read the quickstart
            </a>
            <a className="btn btn-cmd" href="https://www.npmjs.com/package/@moumensoliman/crust">
              <span className="chev">›</span> npx @moumensoliman/crust analyze
            </a>
          </div>
        </div>
        <CodePanel tabs={TABS} />
      </header>

      <section className="rule">
        <div className="sec-head pad">
          <h2>The regression bundle budgets cannot see</h2>
          <p>No build error. No byte moved. The static shell still dropped from 100% to 45%.</p>
        </div>
        <div className="sec-body pad">
          <div className="split">
            <div className="win">
              <div className="win-bar">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                production build
              </div>
              <div className="win-body">
                <div className="rt">
                  <span className="h">Route</span>
                  <span className="h n">First load</span>
                  <span className="h">Shell</span>
                  <span className="h">Mode</span>

                  <span className="route">/</span>
                  <span className="n">143.2 kB</span>
                  <span className="bar">
                    <i style={{ width: '100%' }} />
                  </span>
                  <span className="mode m-static">static</span>

                  <span className="route">/products/[slug]</span>
                  <span className="n">168.4 kB</span>
                  <span className="bar low">
                    <i style={{ width: '45%' }} />
                  </span>
                  <span className="mode m-partial">partial</span>

                  <span className="route">/dashboard</span>
                  <span className="n">152.7 kB</span>
                  <span className="bar low">
                    <i style={{ width: '39%' }} />
                  </span>
                  <span className="mode m-partial">partial</span>
                </div>
              </div>
            </div>

            <div className="win">
              <div className="win-bar">Pull request</div>
              <div className="win-body cmt">
                <h4 className="fail">crust: /products/[slug] is no longer static</h4>
                <div className="row">
                  <span>
                    rendering: <b>static → partial</b>
                    <br />
                    static shell: <b className="fail">100% → 45%</b>
                  </span>
                </div>
                <div className="row">
                  <span>
                    Cause: <code>uncached fetch at lib/http.ts:3</code>
                    <br />
                    Introduced by: <code>&lt;ProductGallery&gt;</code>
                  </span>
                </div>
                <div className="row">
                  <span className="fail">1 failing check · exit 1</span>
                </div>
              </div>
            </div>
          </div>
          <p className="lead" style={{ maxWidth: '70ch' }}>
            A <code>use cache</code> directive was removed three call frames below the page. Conventional
            size checks passed because the JavaScript was identical. crust joined source analysis to
            the emitted shell and named both the call site and the component that left it.
          </p>
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>How it works</h2>
          <p>Source explains why. Production artifacts prove what. History reveals what changed.</p>
        </div>
        <div className="grid">
          {WORKFLOW.map((step) => (
            <div key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>One route-level model</h2>
          <p>Rendering, caching, shell composition and bundles are evidence for the same verdict.</p>
        </div>
        <div className="grid">
          {FEATURES.map((feature) => (
            <div key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>How crust decides</h2>
          <p>A check that fails on guesses gets switched off.</p>
        </div>
        <div className="sec-body pad">
          <div className="nogo">
            {CERTAINTY.map(([title, body]) => (
              <div key={title}>
                <b>{title}</b> {body}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>Beyond the build</h2>
          <p>Useful secondary surfaces. None are required for analyze, diff or CI.</p>
        </div>
        <div className="grid">
          {SECONDARY.map((feature) => (
            <div key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>What it is not</h2>
          <p>The boundary keeps the core small enough to trust.</p>
        </div>
        <div className="sec-body pad">
          <div className="nogo">
            {NON_GOALS.map(([title, body]) => (
              <div key={title}>
                <b>{title}</b> {body}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rule cta pad">
        <h2>Start with one production build</h2>
        <p>
          Explain every route now. Add a baseline, and the next pull request has something honest to
          compare against.
        </p>
        <div className="actions">
          <a className="btn btn-primary" href={`${DOCS}/docs/quickstart`}>
            Get started
          </a>
          <a className="btn btn-cmd" href={`${DOCS}/docs/reference/cli`}>
            <span className="chev">›</span> npx @moumensoliman/crust report --open
          </a>
        </div>
      </section>

      <footer>
        <div className="foot pad">
          <Mark size={14} />
          <a href={DOCS}>Docs</a>
          <span className="sep">/</span>
          <a href={GITHUB}>GitHub</a>
          <span className="sep">/</span>
          <a href={`${GITHUB}/blob/main/LICENSE`}>MIT</a>
          <span className="right">Next.js 15 &amp; 16 · webpack + Turbopack · Node 20+</span>
        </div>
      </footer>
    </div>
  )
}
