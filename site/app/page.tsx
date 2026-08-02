import { CodePanel, type CodeTab } from './code-panel'
import { Mark } from './mark'

const TABS: CodeTab[] = [
  {
    name: 'terminal',
    lines: [
      <>
        <span className="c-dim">$</span> next build <span className="c-dim">&amp;&amp;</span> npx crust diff main
      </>,
      <></>,
      <>
        crust diff <span className="c-dim">cfdcf500 → 4a802397</span>
      </>,
      <></>,
      <>/products/[slug] 543.2 kB <span className="c-dim">+0.0 kB</span></>,
      <span className="c-red">{'    shell 100% → 45%'}</span>,
      <span className="c-red">{'    ✂ <ProductGallery> left the shell'}</span>,
      <span className="c-red">{'      uncached fetch at lib/http.ts:3'}</span>,
      <></>,
      <span className="c-dim">{'2 budget breaches · exit 1'}</span>,
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
        {'  '}<span className="c-key">&quot;firstLoadBytes&quot;</span>: {'{'}
      </>,
      <>
        {'    '}<span className="c-key">&quot;/products/[slug]&quot;</span>: <span className="c-num">180000</span>
      </>,
      <>{'  },'}</>,
      <>
        {'  '}<span className="c-key">&quot;maxGrowth&quot;</span>: <span className="c-num">0.05</span>,
      </>,
      <>
        {'  '}<span className="c-key">&quot;defaultMinShellRatio&quot;</span>: <span className="c-num">0.6</span>
      </>,
      <>{'}'}</>,
      <></>,
      <span className="c-dim">{'// bytes, growth and shell ratio — a check that'}</span>,
      <span className="c-dim">{'// only guards bytes passes a halved shell'}</span>,
    ],
  },
  {
    name: 'devtools.tsx',
    lines: [
      <span className="c-str">{"'use client'"}</span>,
      <></>,
      <>
        <span className="c-key">import</span> {'{ useEffect }'} <span className="c-key">from</span>{' '}
        <span className="c-str">&apos;react&apos;</span>
      </>,
      <></>,
      <>
        <span className="c-key">export function</span> CrustDevtools() {'{'}
      </>,
      <>{'  useEffect(() => {'}</>,
      <>
        {'    '}<span className="c-key">if</span> (!process.env.NEXT_PUBLIC_CRUST) <span className="c-key">return</span>
      </>,
      <>
        {'    import('}<span className="c-str">&apos;crust/widget&apos;</span>{').then((m) => m.mountCrustWidget())'}
      </>,
      <>{'  }, [])'}</>,
      <></>,
      <>
        {'  '}<span className="c-key">return null</span>
      </>,
      <>{'}'}</>,
    ],
  },
]

const FEATURES = [
  {
    title: 'Route-level attribution',
    body: 'Every byte of first-load JS traced to the file that produced it — through barrel files, monorepo packages and both bundlers.',
  },
  {
    title: 'Static shell composition',
    body: 'What is prerendered, what is postponed, and the exact call site that pushed each component out of the shell.',
  },
  {
    title: 'Regression blame',
    body: 'A snapshot per build, keyed on more than the git SHA. Diffs name the module responsible, not just the route that grew.',
  },
  {
    title: 'A check that fails',
    body: 'Budgets on bundle size and shell ratio. The PR comment updates in place instead of stacking on every push.',
  },
  {
    title: 'Runtime, in the page',
    body: 'Web Vitals, long animation frames, an image audit and the streaming waterfall — behind a build-time gate.',
  },
  {
    title: 'Honest unknowns',
    body: 'Anything not lexically resolvable is reported as unknown. A predictor that guesses wrong poisons every number beside it.',
  },
]

const NON_GOALS = [
  ['Not a runtime APM.', 'No error tracking, no distributed tracing, no alerting.'],
  ['Not a Lighthouse replacement.', 'It measures what your build produced, not a lab score.'],
  ['Not multi-framework.', 'Next.js App Router only. Pages Router is detect-and-warn.'],
  ['Not a hosted service.', 'No accounts, no dashboard. Your snapshots live in your repo.'],
  ['Not a bundler.', 'It reads build output and never changes how your app builds.'],
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
          <a href="https://docs.crust.dev">Docs</a>
          <a href="https://docs.crust.dev/concepts/shell-engine">Shell engine</a>
          <a href="https://docs.crust.dev/reference/cli">CLI</a>
        </div>
        <a className="nav-right" href="https://github.com/moumensoliman/crust">
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
            Know what shipped instantly,
            <br />
            and <span className="underlined">what fell out</span>
          </h1>
          <p className="lead">
            crust maps your App Router project from source, joins it to the build output, and keeps a
            snapshot per build — so a regression traces back to the commit and the import that caused it.
          </p>
          <div className="actions">
            <a className="btn btn-primary" href="https://docs.crust.dev/quickstart">
              Read the docs
            </a>
            <a className="btn btn-cmd" href="https://docs.crust.dev/quickstart">
              <span className="chev">›</span> npx crust analyze
            </a>
          </div>
        </div>
        <CodePanel tabs={TABS} />
      </header>

      <section className="rule">
        <div className="sec-head pad">
          <h2>How it works</h2>
          <p>Read the build, predict the shell, check the prediction, then compare against last time.</p>
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
                crust report
              </div>
              <div className="win-body">
                <div className="rt">
                  <span className="h">Route</span>
                  <span className="h n">First load</span>
                  <span className="h">Shell</span>
                  <span className="h">Mode</span>

                  <span className="route">/</span>
                  <span className="n">543.2 kB</span>
                  <span className="bar">
                    <i style={{ width: '100%' }} />
                  </span>
                  <span className="mode m-static">static</span>

                  <span className="route">/products/[slug]</span>
                  <span className="n">543.2 kB</span>
                  <span className="bar low">
                    <i style={{ width: '45%' }} />
                  </span>
                  <span className="mode m-partial">partial</span>

                  <span className="route">/dashboard</span>
                  <span className="n">527.4 kB</span>
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
                <h4 className="fail">crust: 2 budget breaches ✗</h4>
                <div className="row">
                  <span>
                    <code>/dashboard</code> — static shell is 39%, below the 60% floor
                    <br />
                    blame: <code>cookies() at app/dashboard/page.tsx:18</code>
                  </span>
                </div>
                <div className="row">
                  <span>
                    <code>/products/[slug]</code> — static shell is 45%, below the 60% floor
                    <br />
                    blame: <code>uncached fetch at lib/http.ts:3</code>
                  </span>
                </div>
                <div className="row">
                  <span className="fail">
                    &lt;ProductGallery&gt; left the static shell
                  </span>
                </div>
              </div>
            </div>
          </div>
          <p className="lead" style={{ maxWidth: '68ch' }}>
            No build error was produced and no bundle grew. A <code>use cache</code> directive was removed
            three call frames below the page, and 55% of the route silently stopped being static.
          </p>
        </div>
      </section>

      <section className="rule">
        <div className="sec-head pad">
          <h2>What you get</h2>
          <p>A CLI, a snapshot store you can commit, a GitHub Action, an HTML report and an in-page widget.</p>
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
          <h2>What it is not</h2>
          <p>Permanent, and written down before the first user arrived.</p>
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
        <h2>Find out what your shell actually contains</h2>
        <p>crust reads a production build. It refuses to measure dev output, because dev numbers are fiction.</p>
        <div className="actions">
          <a className="btn btn-primary" href="https://docs.crust.dev/quickstart">
            Get started
          </a>
          <a className="btn btn-cmd" href="https://docs.crust.dev/reference/cli">
            <span className="chev">›</span> npx crust report --open
          </a>
        </div>
      </section>

      <footer>
        <div className="foot pad">
          <Mark size={14} />
          <a href="https://docs.crust.dev">Docs</a>
          <span className="sep">/</span>
          <a href="https://github.com/moumensoliman/crust">GitHub</a>
          <span className="sep">/</span>
          <a href="https://github.com/moumensoliman/crust/blob/main/LICENSE">MIT</a>
          <span className="right">Next.js 15 &amp; 16 · issues triaged weekly</span>
        </div>
      </footer>
    </div>
  )
}
