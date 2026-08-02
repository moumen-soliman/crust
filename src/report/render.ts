import type { RouteSnapshot, Snapshot } from '../store/snapshot.ts'
import { renderSparklineSvg, renderTreemapSvg } from './viz.ts'

/**
 * One renderer, two surfaces: the standalone HTML report and the in-app widget
 * inject exactly the same markup and stylesheet. Keeping them in sync by writing
 * the view twice is how the two drift until one of them quietly starts lying.
 *
 * Plain DOM strings rather than a UI framework. This ships into the user's page
 * (behind an env gate), and a renderer that has to agree with the host app's
 * React version is a support burden the widget does not need.
 */

/* ─────────────────────────────────────────────────────────
 * ENTRANCE STORYBOARD
 *
 *    0ms   panel surface is already there
 *   40ms   header + summary figures rise 4px into place
 *  100ms   route rows begin, staggered 18ms apart
 *          (capped at 12 rows — past that the tail reads as lag, not rhythm)
 *
 * Motion is 4px and 260ms. Anything larger on a devtool panel reads as a
 * transition between screens rather than content settling.
 * ───────────────────────────────────────────────────────── */
const ENTER = {
  header: 40, // header and figures
  rows: 100, // first route row
  stagger: 18, // between rows
  maxStagger: 12, // rows that stagger before the rest arrive together
  duration: 260,
}

export function renderReportStyles(): string {
  return `
:host, :root { color-scheme: light dark; }

.crust {
  /* Achromatic by design: every neutral is C=0, so nothing carries a hue cast
     and the four status colors are the only chroma on the surface. OKLCH keeps
     equal L steps reading as equal brightness across the light/dark pair. */
  --bg: oklch(1 0 0);
  --surface: oklch(0.985 0 0);
  --fg: oklch(0.205 0 0);
  --muted: oklch(0.556 0 0);
  --faint: oklch(0.708 0 0);
  --border: oklch(0.922 0 0);

  --blue: oklch(0.58 0.22 254);
  --green: oklch(0.62 0.17 149);
  --amber: oklch(0.68 0.15 72);
  --red: oklch(0.58 0.24 27);

  /* Shadows are reserved for surfaces that genuinely float. Structure inside the
     page is hairlines — a shadow between a table row and its neighbour would be
     depth that doesn't exist. */
  --shadow: 0 2px 4px oklch(0 0 0 / 0.04), 0 12px 32px oklch(0 0 0 / 0.10);

  /* 11 / 12 / 13 / 14 / 22 — five steps, no one-off sizes. */
  --t-label: 11px;
  --t-meta: 12px;
  --t-body: 13px;
  --t-lead: 14px;
  --t-title: 22px;

  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: var(--t-body);
  line-height: 1.5;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--fg);
  background: var(--bg);
}

@media (prefers-color-scheme: dark) {
  .crust {
    --bg: oklch(0 0 0);
    --surface: oklch(0.145 0 0);
    --fg: oklch(0.94 0 0);
    --muted: oklch(0.708 0 0);
    --faint: oklch(0.556 0 0);
    --border: oklch(0.269 0 0);

    --blue: oklch(0.65 0.19 254);
    --green: oklch(0.74 0.18 150);
    --amber: oklch(0.79 0.15 78);
    --red: oklch(0.68 0.21 25);

    --shadow: 0 2px 4px oklch(0 0 0 / 0.5), 0 12px 32px oklch(0 0 0 / 0.45);
  }
}

.crust * { box-sizing: border-box; }

/* ── header ─────────────────────────────────────────────── */

.crust .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.crust h1 {
  font-size: var(--t-lead);
  font-weight: 550;
  line-height: 1.2;
  letter-spacing: -0.011em;
  text-wrap: balance;
  margin: 0;
}
.crust .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--t-meta);
  color: var(--muted); }
.crust .sub { color: var(--muted); font-size: var(--t-meta); margin: 4px 0 0; text-wrap: pretty; }

/* Figures sit on hairlines rather than in cards: at five across, five bordered
   boxes read as five buttons. */
.crust .stats { display: flex; flex-wrap: wrap; gap: 0 32px;
  border-block: 1px solid var(--border); padding: 16px 0; margin: 20px 0 0; }
.crust .stat { min-width: 84px; }
.crust .stat b { display: block; font-size: var(--t-title); font-weight: 550; line-height: 1.15;
  font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.crust .stat span { display: block; color: var(--muted); font-size: var(--t-meta); margin-top: 3px; }

/* ── table ──────────────────────────────────────────────── */

.crust table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.crust th { text-align: start; font-weight: 500; color: var(--muted); font-size: var(--t-meta);
  padding: 14px 10px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.crust td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
/* First-load figures change every build; tabular digits stop the column reflowing. */
.crust td.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }

.crust tr.route { cursor: pointer; }
.crust tr.route td { transition-property: background-color; transition-duration: 100ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1); }
.crust tr.route:hover td { background: var(--surface); }
.crust tr.route:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }

.crust code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--t-meta); }
.crust .path { display: block; max-width: 52ch; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }

/* Status as a dot plus a word, not a filled chip: a row of chips competes with
   the numbers for attention, and the numbers are the point. */
.crust .mode { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-meta);
  color: var(--muted); white-space: nowrap; }
.crust .mode::before { content: ""; width: 6px; height: 6px; border-radius: 999px;
  background: currentColor; flex: none; }
.crust .m-STATIC::before { background: var(--green); }
.crust .m-PARTIALLY_STATIC::before { background: var(--blue); }
.crust .m-DYNAMIC::before { background: var(--amber); }
.crust .m-ISR::before { background: var(--blue); }
.crust .m-ROUTE_HANDLER::before, .crust .m-unknown::before { background: var(--faint); }

.crust .bar { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden;
  min-width: 56px; }
.crust .bar i { display: block; height: 100%; border-radius: 2px; background: var(--fg); }
.crust .bar.low i { background: var(--red); }

/* ── detail ─────────────────────────────────────────────── */

.crust .detail { display: none; }
.crust .detail.open { display: table-row; }
.crust .detail td { padding: 4px 10px 20px; background: var(--surface); }

.crust .hole { color: var(--red); margin: 4px 0; text-wrap: pretty; }
.crust .mod { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 3px 0; }
.crust .mod span { color: var(--muted); font-variant-numeric: tabular-nums; }

.crust .sec { margin-top: 16px; }
.crust .sec > b { display: block; font-size: var(--t-meta); font-weight: 500;
  color: var(--muted); margin-bottom: 6px; }

.crust .note { border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  padding: 12px 14px; margin: 20px 0 0; color: var(--muted); text-wrap: pretty; }
.crust .note b { color: var(--fg); font-weight: 550; }

.crust .empty { color: var(--faint); }

/* ── entrance ───────────────────────────────────────────── */

@keyframes crust-rise { from { opacity: 0; translate: 0 4px; } to { opacity: 1; translate: 0 0; } }

.crust .head, .crust .sub, .crust .stats, .crust .note {
  animation: crust-rise ${ENTER.duration}ms cubic-bezier(0.2, 0, 0, 1) ${ENTER.header}ms backwards;
}
.crust tr.route {
  animation: crust-rise ${ENTER.duration}ms cubic-bezier(0.2, 0, 0, 1) backwards;
  animation-delay: calc(${ENTER.rows}ms + min(var(--i), ${ENTER.maxStagger}) * ${ENTER.stagger}ms);
}

@media (prefers-reduced-motion: reduce) {
  .crust *, .crust *::before, .crust *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    transition-duration: 0.01ms !important;
  }
}
`.trim()
}

export function renderReportBody(snapshot: Snapshot): string {
  const routes = [...snapshot.routes].sort((a, b) => b.firstLoadBytes - a.firstLoadBytes)
  const withShell = routes.filter((r) => r.shell?.actual)
  const avgShell =
    withShell.length > 0
      ? withShell.reduce((sum, r) => sum + (r.shell!.actual!.shellRatio ?? 0), 0) / withShell.length
      : null

  const attributed = routes.some((r) => Object.keys(r.modules).length > 0)

  return `
<div class="crust">
  <div class="head">
    <h1>crust</h1>
    <span class="id">${escape(snapshot.buildId)}</span>
  </div>
  <p class="sub">
    next ${escape(snapshot.nextVersion)} · ${escape(snapshot.bundler)} ·
    ${snapshot.gitSha ? `${escape(snapshot.gitSha.slice(0, 8))}` : 'no git'}${snapshot.dirty ? ' · dirty tree' : ''} ·
    ${escape(new Date(snapshot.createdAt).toLocaleString())}
  </p>

  <div class="stats">
    <div class="stat"><b>${routes.length}</b><span>routes</span></div>
    <div class="stat"><b>${kb(median(routes.map((r) => r.firstLoadBytes)))}</b><span>median first load</span></div>
    <div class="stat"><b>${avgShell === null ? '—' : pct(avgShell)}</b><span>mean shell</span></div>
    <div class="stat"><b>${routes.filter((r) => r.renderingMode === 'DYNAMIC').length}</b><span>dynamic</span></div>
    <div class="stat"><b>${routes.reduce((n, r) => n + (r.shell?.predictedHoles.length ?? 0), 0)}</b><span>holes</span></div>
  </div>

  ${attributed ? '' : `<div class="note"><b>Per-file attribution unavailable.</b> This build shipped without browser source maps, so bytes cannot be traced to a source file. Set <code>productionBrowserSourceMaps: true</code> in next.config and rebuild. Route sizes and shell analysis below are unaffected.</div>`}

  <table>
    <thead><tr>
      <th>Route</th><th class="num">First load</th><th>Trend</th><th>Shell</th><th>Mode</th>
    </tr></thead>
    <tbody>
      ${routes.map((route, i) => renderRoute(route, i, snapshot.history)).join('\n')}
    </tbody>
  </table>
</div>`.trim()
}

function renderRoute(route: RouteSnapshot, i: number, history?: Snapshot['history']): string {
  const trend = history?.[route.id]?.bytes ?? []
  const spark = trend.length >= 2 ? renderSparklineSvg(trend) : '<span class="empty">—</span>'
  const ratio = route.shell?.actual?.shellRatio ?? null
  const bar =
    ratio === null
      ? '<span class="empty">—</span>'
      : `<div class="bar${ratio < 0.5 ? ' low' : ''}" title="${pct(ratio)} static"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>`

  const size = route.renderingMode === 'ROUTE_HANDLER' ? '<span class="empty">—</span>' : kb(route.firstLoadBytes)

  return `
<tr class="route" style="--i:${i}" tabindex="0" role="button" aria-expanded="false" aria-controls="crust-detail-${i}" data-crust-toggle="${i}">
  <td><code>${escape(route.pattern)}</code></td>
  <td class="num">${size}</td>
  <td>${spark}</td>
  <td>${bar}</td>
  <td><span class="mode m-${escape(route.renderingMode)}">${escape(label(route.renderingMode))}</span></td>
</tr>
<tr class="detail" id="crust-detail-${i}"><td colspan="5">${renderDetail(route)}</td></tr>`.trim()
}

function renderDetail(route: RouteSnapshot): string {
  const parts: string[] = []

  if (route.filePath) parts.push(`<div><code class="path" title="${escape(route.filePath)}">${escape(route.filePath)}</code></div>`)
  if (route.renderingModeReason) {
    parts.push(`<div class="sec"><b>Why</b>${escape(route.renderingModeReason)}</div>`)
  }

  const holes = route.shell?.predictedHoles ?? []
  if (holes.length > 0) {
    parts.push(
      `<div class="sec"><b>Out of the shell</b>${holes
        .map((h) => `<div class="hole">&lt;${escape(h.component)}&gt; — ${escape(h.reason)}</div>`)
        .join('')}</div>`,
    )
  }

  const treemapItems = [
    ...Object.entries(route.modules).map(([label, value]) => ({ label, value })),
    ...Object.entries(route.dependencies).map(([label, value]) => ({ label, value })),
  ].filter((item) => item.value > 0)
  if (treemapItems.length > 1) {
    parts.push('<div class="sec"><b>Bundle composition</b>' + renderTreemapSvg(treemapItems.slice(0, 24)) + '</div>')
  }

  const modules = Object.entries(route.modules).slice(0, 12)
  if (modules.length > 0) {
    parts.push(
      `<div class="sec"><b>Your code in this bundle</b>${modules
        .map(([file, bytes]) => `<div class="mod"><code class="path" title="${escape(file)}">${escape(file)}</code><span>${kb(bytes)}</span></div>`)
        .join('')}</div>`,
    )
  }

  const deps = Object.entries(route.dependencies).slice(0, 8)
  if (deps.length > 0) {
    parts.push(
      `<div class="sec"><b>Dependencies</b>${deps
        .map(([pkg, bytes]) => `<div class="mod"><code>${escape(pkg)}</code><span>${kb(bytes)}</span></div>`)
        .join('')}</div>`,
    )
  }

  if (route.clientBoundaryRoots.length > 0) {
    parts.push(
      `<div class="sec"><b>Client boundaries</b>${route.clientBoundaryRoots
        .map((f) => `<div><code class="path" title="${escape(f)}">${escape(f)}</code></div>`)
        .join('')}</div>`,
    )
  }

  if (route.unattributedBytes > 0) {
    parts.push(`<div class="sec"><b>Unattributed</b>${kb(route.unattributedBytes)} — no mapping covers these bytes</div>`)
  }

  return parts.join('') || '<span class="empty">Nothing further to report.</span>'
}

/**
 * Click- and keyboard-to-expand. Inlined so the report stays a single file with
 * no external assets.
 *
 * The rows carry `role="button"`, which promises keyboard operability that a
 * table row does not provide on its own — only native buttons synthesise a click
 * from Enter and Space — so both keys are handled explicitly.
 */
export function renderReportScript(): string {
  return `
(function () {
  var root = document.currentScript ? document.currentScript.getRootNode() : document
  function toggle(row) {
    var id = 'crust-detail-' + row.getAttribute('data-crust-toggle')
    var detail = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id)
    if (!detail) return
    var open = detail.classList.toggle('open')
    row.setAttribute('aria-expanded', String(open))
  }
  function rowFrom(event) {
    return event.target && event.target.closest ? event.target.closest('[data-crust-toggle]') : null
  }
  root.addEventListener('click', function (event) {
    var row = rowFrom(event)
    if (row) toggle(row)
  })
  root.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    var row = rowFrom(event)
    if (!row) return
    event.preventDefault()
    toggle(row)
  })
})();`.trim()
}

/** A single self-contained file: no CDN, no fonts, no external anything. */
export function renderReportHtml(snapshot: Snapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crust · ${escape(snapshot.buildId)}</title>
<style>
body { margin: 0; padding: 40px 32px; background: #fff; }
@media (prefers-color-scheme: dark) { body { background: #000; } }
${renderReportStyles()}
</style>
</head>
<body>
${renderReportBody(snapshot)}
<script>${renderReportScript()}</script>
</body>
</html>
`
}

/* ── formatting ────────────────────────────────────────────────────────── */

const LABELS: Record<string, string> = {
  STATIC: 'static',
  PARTIALLY_STATIC: 'partial',
  DYNAMIC: 'dynamic',
  ISR: 'isr',
  ROUTE_HANDLER: 'handler',
  unknown: 'unknown',
}

const label = (mode: string): string => LABELS[mode] ?? mode
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`
const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
}

/** The snapshot contains file paths and component names from the user's source. */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
