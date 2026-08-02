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

export function renderReportStyles(): string {
  return `
:host, :root { color-scheme: light dark; }

.crust {
  /* OKLCH throughout: equal L steps read as equal brightness, and hue stays put
     across the light/dark pair instead of drifting the way HSL ramps do. */
  --bg: oklch(1 0 0);
  --panel: oklch(0.976 0.003 265);
  --fg: oklch(0.22 0.012 265);
  --dim: oklch(0.52 0.016 265);
  --line: oklch(0.922 0.005 265);
  --accent: oklch(0.55 0.17 255);
  --static: oklch(0.58 0.15 150);
  --partial: oklch(0.6 0.12 210);
  --dynamic: oklch(0.62 0.14 70);
  --bad: oklch(0.56 0.19 25);
  --shadow: 0 1px 2px oklch(0 0 0 / 0.05), 0 4px 12px oklch(0 0 0 / 0.06);

  /* Type scale: 11 / 12 / 13 / 17. Four steps, no one-off sizes. */
  --t-label: 11px;
  --t-meta: 12px;
  --t-body: 13px;
  --t-title: 17px;

  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
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
    --bg: oklch(0.17 0.008 265);
    --panel: oklch(0.212 0.011 265);
    --fg: oklch(0.93 0.006 265);
    --dim: oklch(0.7 0.016 265);
    --line: oklch(0.29 0.012 265);
    --accent: oklch(0.72 0.14 255);
    --static: oklch(0.78 0.16 150);
    --partial: oklch(0.78 0.12 205);
    --dynamic: oklch(0.81 0.13 80);
    --bad: oklch(0.72 0.16 22);
    --shadow: 0 1px 2px oklch(0 0 0 / 0.4), 0 4px 14px oklch(0 0 0 / 0.35);
  }
}

.crust * { box-sizing: border-box; }

.crust h1 {
  font-size: var(--t-title);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.014em;
  text-wrap: balance;
  margin: 0 0 2px;
}
.crust .sub { color: var(--dim); font-size: var(--t-meta); margin-bottom: 16px; text-wrap: pretty; }

.crust .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
/* Concentric: the 24px panel has 16px padding, so inner surfaces take 24-16=8. */
.crust .stat { background: var(--panel); border-radius: 8px; box-shadow: var(--shadow);
  padding: 9px 11px; min-width: 96px; }
.crust .stat b { display: block; font-size: var(--t-title); font-weight: 650; line-height: 1.2;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.crust .stat span { color: var(--dim); font-size: var(--t-label); }

.crust table { width: 100%; border-collapse: collapse; }
.crust th { text-align: start; font-weight: 600; color: var(--dim); font-size: var(--t-label);
  text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 8px;
  border-bottom: 1px solid var(--line); }
.crust td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
/* First-load numbers change between builds, so they must not reflow the column. */
.crust td.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }

.crust tr.route { cursor: pointer; }
.crust tr.route td { transition-property: background-color; transition-duration: 120ms; }
.crust tr.route:hover td { background: var(--panel); }
.crust tr.route:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.crust code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--t-meta); }
.crust .path { display: block; max-width: 52ch; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }

.crust .mode { display: inline-block; font-size: var(--t-label); font-weight: 600;
  padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.crust .m-STATIC { color: var(--static); }
.crust .m-PARTIALLY_STATIC { color: var(--partial); }
.crust .m-DYNAMIC { color: var(--dynamic); }
.crust .m-ISR { color: var(--accent); }
.crust .m-ROUTE_HANDLER, .crust .m-unknown { color: var(--dim); }

.crust .bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden;
  min-width: 56px; }
.crust .bar i { display: block; height: 100%; border-radius: 3px; background: var(--static); }
.crust .bar.low i { background: var(--bad); }

.crust .detail { display: none; background: var(--panel); }
.crust .detail.open { display: table-row; }
.crust .detail td { padding: 12px 14px 16px; }

.crust .hole { color: var(--bad); margin: 3px 0; text-wrap: pretty; }
.crust .mod { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 2px 0; }
.crust .mod span { color: var(--dim); font-variant-numeric: tabular-nums; }

.crust .sec { margin-top: 12px; }
.crust .sec > b { display: block; font-size: var(--t-label); text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--dim); margin-bottom: 5px; }

.crust .note { background: var(--panel); border-radius: 8px; box-shadow: var(--shadow);
  border-inline-start: 3px solid var(--dynamic); padding: 10px 12px; margin-bottom: 14px;
  color: var(--dim); text-wrap: pretty; }
.crust .note b { color: var(--fg); }

.crust .empty { color: var(--dim); font-style: italic; }

@media (prefers-reduced-motion: reduce) {
  .crust *, .crust *::before, .crust *::after { transition-duration: 0.01ms !important; }
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
  <h1>crust · ${escape(snapshot.buildId)}</h1>
  <div class="sub">
    next ${escape(snapshot.nextVersion)} · ${escape(snapshot.bundler)} ·
    ${routes.length} routes ·
    ${snapshot.gitSha ? `<code>${escape(snapshot.gitSha.slice(0, 8))}</code>` : 'no git'}${snapshot.dirty ? ' (dirty tree)' : ''} ·
    ${escape(new Date(snapshot.createdAt).toLocaleString())}
  </div>

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
<tr class="route" tabindex="0" role="button" aria-expanded="false" aria-controls="crust-detail-${i}" data-crust-toggle="${i}">
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
body { margin: 0; padding: 24px; background: #fff; }
@media (prefers-color-scheme: dark) { body { background: #0f1115; } }
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
