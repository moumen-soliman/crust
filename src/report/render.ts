import { causeChainLines } from '../analyze/cause.ts'
import { coverageLines } from '../analyze/coverage.ts'
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
 *   80ms   shared causes - the blast radius, one beat after the figures
 *  120ms   route rows begin, staggered 18ms apart
 *          (capped at 12 rows - past that the tail reads as lag, not rhythm)
 *
 * Motion is 4px and 260ms. Anything larger on a devtool panel reads as a
 * transition between screens rather than content settling.
 * ───────────────────────────────────────────────────────── */
const ENTER = {
  header: 40, // header and figures
  causes: 80, // shared-cause list
  rows: 120, // first route row
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
  --surface: oklch(0.977 0 0);
  --fg: oklch(0.205 0 0);
  --muted: oklch(0.556 0 0);
  --faint: oklch(0.708 0 0);
  --border: oklch(0.922 0 0);
  --border-strong: oklch(0.87 0 0);

  --blue: oklch(0.58 0.22 254);
  --green: oklch(0.62 0.17 149);
  --amber: oklch(0.68 0.15 72);
  --red: oklch(0.58 0.24 27);

  /* Shadows are reserved for surfaces that genuinely float. Structure inside the
     page is hairlines - a shadow between a table row and its neighbour would be
     depth that doesn't exist. */
  --shadow: 0 2px 4px oklch(0 0 0 / 0.04), 0 12px 32px oklch(0 0 0 / 0.10);

  /* Concentric: a card at 12 holds inner surfaces at 8 across 4px of padding,
     and controls at 6. Nothing nested repeats its parent's radius. */
  --r-card: 12px;
  --r-inner: 8px;
  --r-ctl: 6px;

  --ease: cubic-bezier(0.2, 0, 0, 1);

  /* 11 / 12 / 13 / 14 / 15 / 19 / 24 - seven steps, no one-off sizes. Levels
     descend: the page title outranks a section head outranks a figure label. */
  --t-label: 11px;
  --t-meta: 12px;
  --t-body: 13px;
  --t-lead: 14px;
  --t-h2: 15px;
  --t-h1: 19px;
  --t-figure: 24px;

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
    --surface: oklch(0.16 0 0);
    --fg: oklch(0.94 0 0);
    --muted: oklch(0.708 0 0);
    --faint: oklch(0.556 0 0);
    --border: oklch(0.269 0 0);
    --border-strong: oklch(0.34 0 0);

    --blue: oklch(0.65 0.19 254);
    --green: oklch(0.74 0.18 150);
    --amber: oklch(0.79 0.15 78);
    --red: oklch(0.68 0.21 25);

    --shadow: 0 2px 4px oklch(0 0 0 / 0.5), 0 12px 32px oklch(0 0 0 / 0.45);
  }
}

.crust * { box-sizing: border-box; }
.crust ::selection { background: color-mix(in srgb, var(--blue) 24%, transparent); }

/* ── header ─────────────────────────────────────────────── */

.crust .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.crust h1 {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: var(--t-h1);
  font-weight: 560;
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-wrap: balance;
  margin: 0;
}
.crust h1 svg { width: 15px; height: 15px; flex: none; }
/* The build id is an identifier, not prose: it never wraps and never inherits
   the heading's optical tracking. */
.crust .id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--t-label);
  letter-spacing: 0; color: var(--muted); white-space: nowrap;
  padding: 3px 7px; border: 1px solid var(--border); border-radius: var(--r-ctl);
}
.crust .sub { color: var(--muted); font-size: var(--t-meta); margin: 6px 0 0; text-wrap: pretty; }

/* ── figures ────────────────────────────────────────────── */

/* One card, hairline-divided. Six bordered boxes read as six buttons; one card
   with rules between the figures reads as one measurement.

   The rules are shadows on the cells rather than borders, because the figures
   wrap to two and three columns on narrow screens and a border can only guess
   where the rows will break. Gaps over a coloured card would do the same job,
   except that an incomplete final row leaves its empty grid tracks painted in
   the divider colour. The outermost rules fall on the card's inner edge and
   are clipped away by the card's own overflow. */
.crust .stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); overflow: hidden; margin: 24px 0 0;
}

/* The figures and the coverage line are one card with a footer, so the corners
   belong to the card and not to either half. Rounding both separately left the
   figures' bottom corners curving away above a square-cornered strip, which
   reads as two boxes that failed to meet. */
.crust .summary {
  border: 1px solid var(--border); border-radius: var(--r-card);
  overflow: hidden; margin: 24px 0 0;
}
.crust .summary .stats { border: 0; border-radius: 0; margin: 0; }
.crust .stat {
  padding: 14px 16px; min-width: 0; border: 0;
  text-align: start; font: inherit; background: var(--bg); color: inherit;
  box-shadow: 1px 0 0 var(--border), 0 1px 0 var(--border);
}
/* The final figure is the one whose right-hand rule can end up hanging beside
   the empty tail of a part-filled row. */
.crust .stat:last-child { box-shadow: 0 1px 0 var(--border); }
.crust .stat b {
  display: block; font-size: var(--t-figure); font-weight: 550; line-height: 1.1;
  font-variant-numeric: tabular-nums; letter-spacing: -0.025em;
}
.crust .stat span {
  display: block; color: var(--muted); font-size: var(--t-meta); margin-top: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* A figure that names a problem should be able to show you the problem. */
.crust button.stat { cursor: pointer;
  transition-property: background-color; transition-duration: 100ms; transition-timing-function: var(--ease); }
.crust button.stat:hover { background: var(--surface); }
.crust button.stat:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
/* An arrow rather than a caret: a caret next to a figure in a table-shaped
   layout reads as a sort direction, which is not what pressing this does. */
.crust button.stat span::after {
  content: " →"; color: var(--faint); font-size: var(--t-label);
}
.crust button.stat:hover span::after { color: var(--fg); }
.crust .stat.flag b { color: var(--amber); }

/* The rule above it is the divider between the figures and their footnote; the
   card's own border supplies every outer edge. */
.crust .coverage {
  border: 0; border-block-start: 1px solid var(--border);
  margin: 0; padding: 9px 16px; color: var(--muted); font-size: var(--t-meta);
  background: var(--surface);
}

/* ── section heads ──────────────────────────────────────── */

.crust h2 {
  font-size: var(--t-h2); font-weight: 550; margin: 0; letter-spacing: -0.014em;
  line-height: 1.2; text-wrap: balance;
}
.crust .sec-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 32px 0 10px; }
.crust .sec-head .sub { margin: 0; }

/* ── shared causes ──────────────────────────────────────── */

.crust .causes {
  border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; background: var(--bg);
}
.crust .cause {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start;
  gap: 8px 12px; padding: 12px 14px; cursor: pointer;
  border-block-start: 1px solid var(--border);
  transition-property: background-color; transition-duration: 100ms; transition-timing-function: var(--ease);
}
.crust .cause:first-child { border-block-start: 0; }
.crust .cause:hover { background: var(--surface); }
.crust .cause:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
/* Clicking a cause filters the table. Without a held state the list forgets
   which one is driving the view the moment the pointer leaves. */
.crust .cause[aria-pressed="true"] { background: var(--surface); box-shadow: inset 2px 0 0 var(--fg); }
.crust .cause-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.crust .cause-head b { font-weight: 550; }
.crust .cause .meta { display: block; color: var(--muted); font-size: var(--t-meta); margin-top: 3px; }
.crust .cause .routes { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 7px; }
.crust .cause .routes code {
  padding: 1px 6px; border-radius: var(--r-ctl); background: var(--surface);
  border: 1px solid var(--border); color: var(--muted);
}
.crust .cause[aria-pressed="true"] .routes code { border-color: var(--border-strong); color: var(--fg); }
.crust .cause .more { align-self: center; color: var(--faint); font-size: var(--t-label); }

/* Outlined rather than filled: a filled tint block at 10px is a colour swatch
   that outweighs the label it is qualifying. */
.crust .kind, .crust .ev {
  display: inline-block; flex: none; padding: 1px 6px; border-radius: var(--r-ctl);
  font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.045em;
  color: var(--muted); border: 1px solid var(--border);
  background: color-mix(in srgb, var(--muted) 8%, transparent);
}
.crust .k-client-boundary, .crust .k-barrel {
  color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  background: color-mix(in srgb, var(--amber) 10%, transparent);
}
.crust .k-layout, .crust .k-package {
  color: var(--blue); border-color: color-mix(in srgb, var(--blue) 40%, transparent);
  background: color-mix(in srgb, var(--blue) 10%, transparent);
}

/* ── buttons ────────────────────────────────────────────── */

.crust .copy {
  align-self: center; padding: 5px 10px; font: inherit; font-size: var(--t-label); cursor: pointer;
  color: var(--muted); background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-ctl); white-space: nowrap;
  transition-property: color, background-color, scale; transition-duration: 120ms;
  transition-timing-function: var(--ease);
}
.crust .copy:hover { color: var(--fg); background: var(--surface); }
.crust .copy:active { scale: 0.96; }
.crust .copy:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
/* 28px tall by choice, 40px to the pointer: a devtool control should not be
   chunky, and it should not be a target you can miss. */
.crust .copy { position: relative; }
.crust .copy::after { content: ""; position: absolute; inset: -6px -4px; }
@media (pointer: coarse) { .crust .copy::after { inset: -9px -6px; } }

/* ── controls ───────────────────────────────────────────── */

/* Sticky: the filters are how you read a 200-route table, and a control you
   have to scroll back up to reach stops being used after the first screen. */
.crust .controls {
  position: sticky; top: 0; z-index: 2;
  display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center;
  padding: 10px 0; margin: 0 0 8px;
  background: var(--bg);
  border-block-end: 1px solid var(--border);
}
.crust .search { position: relative; flex: 1 1 240px; min-width: 0; display: flex; }
.crust .search svg { position: absolute; inset-inline-start: 10px; top: 50%; translate: 0 -50%;
  width: 13px; height: 13px; color: var(--faint); pointer-events: none; }
.crust .controls input[type="search"] {
  flex: 1; min-width: 0; height: 34px; padding: 0 10px 0 30px; font: inherit; font-size: var(--t-meta);
  color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-inner);
  transition-property: border-color; transition-duration: 120ms; transition-timing-function: var(--ease);
}
.crust .controls input[type="search"]::placeholder { color: var(--faint); }
.crust .controls input[type="search"]:hover { border-color: var(--border-strong); }
.crust .controls input[type="search"]:focus-visible { outline: 2px solid var(--blue); outline-offset: -1px; }

.crust .group { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The eight pills used to sit in one undifferentiated row; five of them filter
   and three of them group, and nothing said so. */
.crust .group > .label {
  font-size: var(--t-label); text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--faint); white-space: nowrap; user-select: none;
}
.crust .chips { display: flex; flex-wrap: wrap; gap: 5px; }
.crust .chip {
  display: inline-flex; align-items: center; gap: 5px; position: relative;
  height: 28px; padding: 0 11px; font: inherit; font-size: var(--t-label); font-weight: 500;
  color: var(--muted); cursor: pointer; white-space: nowrap; user-select: none;
  background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
  transition-property: background-color, color, border-color, scale;
  transition-duration: 120ms; transition-timing-function: var(--ease);
}
.crust .chip::after { content: ""; position: absolute; inset: -6px -2px; }
@media (pointer: coarse) { .crust .chip { height: 34px; } .crust .chip::after { inset: -5px -2px; } }
.crust .chip:hover:not(:disabled) { color: var(--fg); background: var(--surface); border-color: var(--border-strong); }
.crust .chip:active:not(:disabled) { scale: 0.96; }
.crust .chip:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.crust .chip.on { color: var(--bg); background: var(--fg); border-color: var(--fg); }
/* The count is known at render time. Showing it saves a click that returns
   nothing, and tells you where the interesting routes are before you look. */
.crust .chip .n { font-variant-numeric: tabular-nums; opacity: 0.6; }
.crust .chip.on .n { opacity: 0.7; }
.crust .chip:disabled { cursor: default; opacity: 0.42; }

.crust .count { color: var(--muted); font-size: var(--t-meta); white-space: nowrap;
  font-variant-numeric: tabular-nums; margin-inline-start: auto; }

/* ── table ──────────────────────────────────────────────── */

/* The measure is the point: at full window width a route pattern and its
   rendering mode end up an inch apart with nothing joining them. */
.crust .table-wrap {
  border: 1px solid var(--border); border-radius: var(--r-card); overflow: auto hidden;
  background: var(--bg);
}
.crust table { width: 100%; border-collapse: collapse; min-width: 620px; }
.crust th {
  text-align: start; font-weight: 500; color: var(--muted); font-size: var(--t-label);
  text-transform: uppercase; letter-spacing: 0.05em;
  padding: 9px 14px; background: var(--surface);
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
.crust td { padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.crust tbody tr:last-child td { border-bottom: 0; }
/* First-load figures change every build; tabular digits stop the column reflowing. */
.crust td.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }

.crust tr.route { cursor: pointer; }
.crust tr.route td { transition-property: background-color; transition-duration: 100ms;
  transition-timing-function: var(--ease); }
.crust tr.route:hover td { background: var(--surface); }
.crust tr.route[aria-expanded="true"] td { background: var(--surface); }
.crust tr.route:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.crust .route-name { display: flex; align-items: center; gap: 2px; min-width: 0; }
.crust .disclosure { display: inline-block; width: 15px; flex: none; color: var(--faint);
  transition: transform 140ms var(--ease); transform-origin: 45% 50%; }
.crust tr.route[aria-expanded="true"] .disclosure { transform: rotate(90deg); color: var(--fg); }
.crust .route-name code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.crust code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--t-meta); }
.crust .path { display: block; max-width: 60ch; overflow: hidden; text-overflow: ellipsis;
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

/* The size column ranks itself without anyone reading the numbers: the rule
   under each figure is that route's share of the largest route in the build.
   It stays under the text colour - at full brightness it stops reading as a
   measure and starts reading as an underline on the figure. */
.crust .size { display: inline-flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 78px; }
.crust .size u { display: block; height: 2px; border-radius: 1px; background: var(--border); text-decoration: none; }
.crust .size u i { display: block; height: 100%; border-radius: 1px;
  background: color-mix(in srgb, var(--muted) 42%, transparent); }
.crust tr.route:hover .size u i { background: color-mix(in srgb, var(--muted) 75%, transparent); }

/* Healthy is quiet. Filling the bar with --fg made a full shell the loudest
   mark in the table, which is exactly backwards for a health measure. */
.crust .shell-cell { display: flex; align-items: center; gap: 8px; }
.crust .bar { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden;
  flex: 1 1 56px; min-width: 44px; max-width: 120px; }
.crust .bar i { display: block; height: 100%; border-radius: 2px; background: var(--muted); }
.crust .bar.low i { background: var(--red); }
.crust .shell-cell span { font-size: var(--t-meta); color: var(--muted);
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.crust .shell-cell.low span { color: var(--red); }

/* A squiggle answers "is it moving"; the number answers "by how much". */
.crust .trend { display: flex; align-items: center; gap: 8px; }
.crust .trend span { font-size: var(--t-meta); font-variant-numeric: tabular-nums;
  color: var(--faint); white-space: nowrap; }
.crust .trend.up span { color: var(--red); }
.crust .trend.down span { color: var(--green); }

.crust tr.hidden, .crust tr.detail.hidden { display: none; }
.crust tr.grouphead td {
  padding: 8px 14px; font-size: var(--t-label); letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--border);
}
/* A header over blank space is not an answer. */
.crust tr.no-match { display: none; }
.crust tr.no-match.on { display: table-row; }
.crust tr.no-match td { padding: 40px 14px; text-align: center; color: var(--muted); text-wrap: pretty; }
.crust tr.no-match b { display: block; color: var(--fg); font-weight: 550; margin-bottom: 2px; }

/* ── detail ─────────────────────────────────────────────── */

.crust .detail { display: none; }
.crust .detail.open { display: table-row; }
.crust .detail > td { padding: 0; background: var(--surface); }
/* The rail lands under the disclosure arrow, so the drawer reads as belonging
   to the row above it rather than as the next row. */
.crust .drawer {
  padding: 6px 14px 20px 28px; margin-inline-start: 14px;
  border-inline-start: 1px solid var(--border);
  overflow-wrap: anywhere;
}
/* Three lists stacked make a 2,000px drawer nobody scrolls to the end of. */
.crust .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0 28px; }

.crust .hole { color: var(--red); margin: 4px 0; text-wrap: pretty; }
.crust .chain { margin: 8px 0 14px; padding-inline-start: 12px; border-inline-start: 1px solid var(--border); }
.crust .hop { color: var(--muted); font-size: var(--t-meta); padding: 1px 0; text-wrap: pretty; }
.crust .hop::before { content: '→ '; opacity: 0.5; }
.crust .hop.first { color: var(--fg); font-weight: 600; font-size: var(--t-body); }
.crust .hop.first::before { content: none; }
.crust .ev { margin-bottom: 5px; }
.crust .ev-verified { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent); }
.crust .ev-inferred { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  background: color-mix(in srgb, var(--amber) 10%, transparent); }
.crust .ev-unknown { color: var(--muted); }

.crust .mod { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 3px 0;
  align-items: baseline; }
.crust .mod span { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

.crust .sec { margin-top: 18px; }
.crust .sec > b { display: block; font-size: var(--t-label); font-weight: 500; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--faint); margin-bottom: 6px; }

.crust .tm-head { display: flex; align-items: center; justify-content: space-between;
  gap: 16px; margin-bottom: 8px; }
.crust .tm-head b { font-size: var(--t-label); font-weight: 500; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--faint); }
.crust .tm-scale { display: inline-flex; align-items: center; gap: 6px; color: var(--faint);
  font-size: var(--t-label); white-space: nowrap; }
/* Matches the single-hue ramp the cells are painted with. A legend that shows a
   different gradient from the chart is worse than no legend. */
.crust .tm-scale i { width: 64px; height: 5px; border-radius: 999px;
  background: linear-gradient(90deg, oklch(0.93 0.02 254), oklch(0.68 0.13 254)); }
@media (prefers-color-scheme: dark) {
  .crust .tm-scale i { background: linear-gradient(90deg, oklch(0.26 0.03 254), oklch(0.52 0.14 254)); }
}

.crust .note { border: 1px solid var(--border); border-radius: var(--r-card); background: var(--surface);
  padding: 13px 16px; margin: 20px 0 0; color: var(--muted); text-wrap: pretty; }
.crust .note b { color: var(--fg); font-weight: 550; }

.crust .empty { color: var(--faint); }

/* ── entrance ───────────────────────────────────────────── */

@keyframes crust-rise { from { opacity: 0; translate: 0 4px; } to { opacity: 1; translate: 0 0; } }

/* The summary card rises as one piece. Animating the figures and the footnote
   separately would pull apart the seam the card exists to hide. */
.crust .head, .crust .sub, .crust .summary, .crust .stats, .crust .note {
  animation: crust-rise ${ENTER.duration}ms cubic-bezier(0.2, 0, 0, 1) ${ENTER.header}ms backwards;
}
.crust .summary .stats { animation: none; }
.crust .causes {
  animation: crust-rise ${ENTER.duration}ms cubic-bezier(0.2, 0, 0, 1) ${ENTER.causes}ms backwards;
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
  .crust .chip:active, .crust .copy:active { scale: 1; }
}

/* iOS Safari zooms the page whenever a focused input is under 16px. */
@media (max-width: 640px) {
  .crust .controls { position: static; }
  .crust .controls input[type="search"] { font-size: 16px; height: 38px; }
  .crust .count { margin-inline-start: 0; }
  /* Side by side, the button ends up optically centred against three wrapped
     lines of route chips and collides with them. */
  .crust .cause { grid-template-columns: minmax(0, 1fr); }
  .crust .copy { justify-self: start; }
  .crust .drawer { padding-inline: 4px 0; margin-inline-start: 10px; }
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
  const holes = routes.reduce((n, r) => n + (r.shell?.predictedHoles.length ?? 0), 0)
  const dynamic = routes.filter((r) => r.renderingMode === 'DYNAMIC').length
  const counts = filterCounts(routes)
  const heaviest = Math.max(1, ...routes.map((r) => r.firstLoadBytes))

  return `
<div class="crust">
  <div class="head">
    <h1>${MARK}crust</h1>
    <span class="id">${escape(snapshot.buildId)}</span>
  </div>
  <p class="sub">
    next ${escape(snapshot.nextVersion)} · ${escape(snapshot.bundler)} ·
    ${snapshot.gitSha ? `${escape(snapshot.gitSha.slice(0, 8))}` : 'no git'}${snapshot.dirty ? ' · dirty tree' : ''} ·
    ${escape(new Date(snapshot.createdAt).toLocaleString())}
  </p>

  <div class="summary">
    <div class="stats">
      ${stat(String(routes.length), 'routes')}
      ${stat(kb(median(routes.map((r) => r.firstLoadBytes))), 'median first load')}
      ${stat(avgShell === null ? '-' : pct(avgShell), 'mean shell')}
      ${stat(String(dynamic), 'dynamic', { jump: dynamic > 0 ? 'dynamic' : null, flag: dynamic > 0 })}
      ${stat(String(holes), 'holes', { flag: holes > 0 })}
      ${stat(`${Math.round(snapshot.coverage.confidence * 100)}%`, 'confidence')}
    </div>
    <p class="coverage">${coverageLines(snapshot.coverage).map(escape).join(' · ')}</p>
  </div>

  ${attributed ? '' : `<div class="note"><b>Per-file attribution unavailable.</b> This build shipped without browser source maps, so bytes cannot be traced to a source file. Set <code>productionBrowserSourceMaps: true</code> in next.config and rebuild. Route sizes and shell analysis below are unaffected.</div>`}

  ${renderSharedCauses(snapshot)}

  <div class="sec-head">
    <h2>Routes</h2>
    <p class="sub route-help">Open any route to inspect its cause chains, shell exits, and bundle composition.</p>
  </div>

  <div class="controls">
    <div class="search">
      ${SEARCH_ICON}
      <input type="search" id="crust-search" placeholder="Search routes, components, source files…" aria-label="Search routes, components and source files">
    </div>
    <div class="group">
      <span class="label" id="crust-filter-label">Filter</span>
      <div class="chips" role="group" aria-labelledby="crust-filter-label">
        ${['all', 'dynamic', 'partial', 'heavy', 'unattributed']
          .map((filter, index) => chip('filter', filter, FILTER_LABELS[filter]!, index === 0, counts[filter] ?? 0))
          .join('')}
      </div>
    </div>
    <div class="group">
      <span class="label" id="crust-group-label">Group</span>
      <div class="chips" role="group" aria-labelledby="crust-group-label">
        ${['none', 'layout', 'package']
          .map((group, index) => chip('group', group, GROUP_LABELS[group]!, index === 0, null))
          .join('')}
      </div>
    </div>
    <p class="count" id="crust-count" aria-live="polite"></p>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Route</th><th class="num">First load</th><th>Trend</th><th>Shell</th><th>Mode</th>
      </tr></thead>
      <tbody>
        ${routes
          .map((route, i) => renderRoute(route, i, snapshot.history, packagesByRoute(snapshot), heaviest))
          .join('\n')}
        <tr class="no-match" id="crust-no-match"><td colspan="5">
          <b>No routes match</b>Clear the search box or pick a different filter.
        </td></tr>
      </tbody>
    </table>
  </div>
</div>`.trim()
}

/** The wordmark, inlined: the report is one file with no external assets. */
const MARK =
  '<svg viewBox="0 0 32 32" aria-hidden="true" fill="currentColor"><path d="M26 5v5H6V5h20Z"/><path d="M26 12.5V27H13a7 7 0 0 1-7-7V12.5h20Z"/></svg>'

const SEARCH_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 14 14" stroke-linecap="round"/></svg>'

function stat(value: string, label: string, options: { jump?: string | null; flag?: boolean } = {}): string {
  const cls = `stat${options.flag ? ' flag' : ''}`
  const body = `<b>${value}</b><span>${label}</span>`
  // A figure that names a problem should be able to show you the problem: the
  // stat presses the filter chip that isolates exactly those routes.
  return options.jump
    ? `<button type="button" class="${cls}" data-crust-jump="${options.jump}" title="Show only these routes">${body}</button>`
    : `<div class="${cls}">${body}</div>`
}

function chip(kind: 'filter' | 'group', value: string, label: string, on: boolean, count: number | null): string {
  const empty = count === 0
  return (
    `<button type="button" class="chip${on ? ' on' : ''}" data-crust-${kind}="${value}"` +
    `${empty ? ' disabled' : ''} aria-pressed="${on}">${label}` +
    `${count === null ? '' : `<span class="n">${count}</span>`}</button>`
  )
}

/**
 * How many routes each filter would leave. Computed here rather than in the
 * browser so the numbers are in the markup even with scripting off - and kept
 * in the same order as the matcher in `renderReportScript`, which is the only
 * thing that has to agree with them.
 */
function filterCounts(routes: RouteSnapshot[]): Record<string, number> {
  return {
    all: routes.length,
    dynamic: routes.filter((r) => r.renderingMode === 'DYNAMIC').length,
    partial: routes.filter((r) => r.renderingMode === 'PARTIALLY_STATIC').length,
    heavy: routes.filter((r) => r.firstLoadBytes > 250_000).length,
    unattributed: routes.filter((r) => unattributedShare(r) > 0.2).length,
  }
}

function unattributedShare(route: RouteSnapshot): number {
  const attributed = Object.values(route.modules).reduce((sum, bytes) => sum + bytes, 0)
  const total = attributed + route.unattributedBytes
  return total > 0 ? route.unattributedBytes / total : 0
}

const FILTER_LABELS: Record<string, string> = {
  all: 'All',
  dynamic: 'Dynamic',
  partial: 'Partially static',
  heavy: 'Over 250 kB',
  unattributed: 'Unattributed bytes',
}

const GROUP_LABELS: Record<string, string> = {
  none: 'None',
  layout: 'Layout',
  package: 'Package',
}

/**
 * The blast radius, at the top, before the route table.
 *
 * Placement is the argument: a shared cause is the largest thing in most builds
 * and the route table is where it disappears, split into twenty small rows.
 * Each entry filters the table to its own routes, which is the roadmap's "show
 * every route affected by a shared import" without a second view to maintain.
 */
function renderSharedCauses(snapshot: Snapshot): string {
  const causes = snapshot.sharedCauses.slice(0, 12)
  if (causes.length === 0) return ''

  // Route lists run long. Six is enough to recognise the blast radius; the rest
  // are one click away in the table, which is where you would read them anyway.
  const SHOWN_ROUTES = 6

  return `
  <div class="sec-head">
    <h2>Shared causes</h2>
    <p class="sub">One root cause, every route it reaches. Select one to filter the table.</p>
  </div>
  <div class="causes shared">
    ${causes
      .map((cause) => {
        const cost =
          cause.bytesPerRoute !== null
            ? `adds ${kb(cause.bytesPerRoute)} to ${cause.routes.length} routes`
            : `affects ${cause.routes.length} routes`
        const shown = cause.routes.slice(0, SHOWN_ROUTES)
        const rest = cause.routes.length - shown.length
        return `
    <div class="cause" role="button" tabindex="0" aria-pressed="false"
      aria-label="Filter the table to the ${cause.routes.length} routes reached by ${escape(cause.label)}"
      data-crust-routes="${escape(cause.routes.join(' '))}">
      <div>
        <div class="cause-head">
          <span class="kind k-${escape(cause.kind)}">${escape(cause.kind)}</span>
          <b>${escape(cause.label)}</b>
          <span class="sub">${escape(cost)}</span>
        </div>
        ${cause.introducedBy ? `<span class="meta">Introduced by <code>${escape(cause.introducedBy)}</code></span>` : ''}
        <div class="routes">${shown.map((r) => `<code>${escape(r)}</code>`).join('')}${
          rest > 0 ? `<span class="more">+${rest} more</span>` : ''
        }</div>
      </div>
      <button type="button" class="copy" data-crust-copy="${escape(prExplanation(cause))}">Copy for PR</button>
    </div>`
      })
      .join('')}
  </div>`
}

/** A shared cause as a line someone can paste into a review without editing it. */
function prExplanation(cause: Snapshot['sharedCauses'][number]): string {
  const cost = cause.bytesPerRoute !== null ? ` adds ${kb(cause.bytesPerRoute)} to` : ' affects'
  const owner = cause.introducedBy ? ` Introduced by ${cause.introducedBy}.` : ''
  return `${cause.label}${cost} ${cause.routes.length} routes (${cause.routes.slice(0, 5).join(', ')}${
    cause.routes.length > 5 ? ', …' : ''
  }).${owner} Evidence: ${cause.evidence}.`
}

/**
 * The haystack the search box matches against: the route, every component the
 * evidence names, and every source file attributed to it. Searching only the
 * pattern would answer the one question a reader can already answer by looking.
 */
function searchIndexFor(route: RouteSnapshot): string {
  return [
    route.pattern,
    route.filePath ?? '',
    ...route.causes.map((cause) => `${cause.component ?? ''} ${cause.site ?? ''} ${cause.detail}`),
    ...route.clientBoundaries.map((boundary) => `${boundary.component ?? ''} ${boundary.file}`),
    ...Object.keys(route.modules),
    ...Object.keys(route.dependencies),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * Route pattern -> the workspace packages that contribute code to it, taken
 * from the shared-cause grouping so the report and the blast radius cannot
 * disagree about which package a route depends on.
 */
function packagesByRoute(snapshot: Snapshot): Map<string, string[]> {
  const byRoute = new Map<string, string[]>()
  for (const cause of snapshot.sharedCauses) {
    if (cause.kind !== 'package') continue
    for (const pattern of cause.routes) byRoute.set(pattern, [...(byRoute.get(pattern) ?? []), cause.label])
  }
  return byRoute
}

function renderRoute(
  route: RouteSnapshot,
  i: number,
  history?: Snapshot['history'],
  packages: Map<string, string[]> = new Map(),
  heaviest = 1,
): string {
  const trend = history?.[route.id]?.bytes ?? []
  // The squiggle answers "is it moving", the percentage answers "by how much".
  // On its own the sparkline is a shape with no units, which is why the first
  // question anyone asked of it was what the y-axis meant.
  const spark = trend.length >= 2 ? renderSparklineSvg(trend) : ''
  const delta = trend.length >= 2 ? (trend[trend.length - 1]! - trend[0]!) / (trend[0]! || 1) : null
  const direction = delta === null ? '' : delta > 0.02 ? ' up' : delta < -0.02 ? ' down' : ''
  const trendCell =
    delta === null
      ? '<span class="empty">-</span>'
      : `<div class="trend${direction}" title="Change over the last ${trend.length} builds">${spark}` +
        `<span>${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}%</span></div>`

  const ratio = route.shell?.actual?.shellRatio ?? null
  const low = ratio !== null && ratio < 0.5
  const shellCell =
    ratio === null
      ? '<span class="empty">-</span>'
      : `<div class="shell-cell${low ? ' low' : ''}"><div class="bar${low ? ' low' : ''}">` +
        `<i style="width:${(ratio * 100).toFixed(1)}%"></i></div><span>${pct(ratio)}</span></div>`

  // The rule under the figure is this route's share of the largest route in the
  // build, so the column ranks itself without anyone reading the numbers.
  const size =
    route.renderingMode === 'ROUTE_HANDLER'
      ? '<span class="empty">-</span>'
      : `<span class="size">${kb(route.firstLoadBytes)}<u><i style="width:${(
          (route.firstLoadBytes / heaviest) * 100
        ).toFixed(1)}%"></i></u></span>`

  return `
<tr class="route" style="--i:${i}" tabindex="0" role="button" aria-expanded="false" aria-controls="crust-detail-${i}" data-crust-toggle="${i}"
  data-pattern="${escape(route.pattern)}"
  data-mode="${escape(route.renderingMode)}"
  data-bytes="${route.firstLoadBytes}"
  data-unattributed="${unattributedShare(route).toFixed(3)}"
  data-layout="${escape(route.layouts.join(' ') || '(no layout)')}"
  data-package="${escape((packages.get(route.pattern) ?? []).join(' ') || '(no workspace package)')}"
  data-search="${escape(searchIndexFor(route))}">
  <td><span class="route-name"><span class="disclosure" aria-hidden="true">›</span><code>${escape(route.pattern)}</code></span></td>
  <td class="num">${size}</td>
  <td>${trendCell}</td>
  <td>${shellCell}</td>
  <td><span class="mode m-${escape(route.renderingMode)}">${escape(label(route.renderingMode))}</span></td>
</tr>
<tr class="detail" id="crust-detail-${i}"><td colspan="5"><div class="drawer">${renderDetail(route)}</div></td></tr>`.trim()
}

function renderDetail(route: RouteSnapshot): string {
  const parts: string[] = []

  if (route.filePath) parts.push(`<div><code class="path" title="${escape(route.filePath)}">${escape(route.filePath)}</code></div>`)
  if (route.renderingModeReason) {
    parts.push(`<div class="sec"><b>Why</b>${escape(route.renderingModeReason)}</div>`)
  }

  // The complete chain lives here rather than in the terminal: the report is
  // where someone goes to follow it, and truncating a cause chain is what makes
  // it unusable - the two ends are the component and the call.
  if (route.causes.length > 0) {
    parts.push(
      `<div class="sec"><b>Cause chains</b>${route.causes
        .map((cause) => {
          const hops = causeChainLines(cause)
            .map((line, index) => `<div class="hop${index === 0 ? ' first' : ''}">${escape(line)}</div>`)
            .join('')
          return `<div class="chain"><span class="ev ev-${cause.evidence}">${cause.evidence}</span>${hops}</div>`
        })
        .join('')}</div>`,
    )
  }

  const holes = route.shell?.predictedHoles ?? []
  if (holes.length > 0) {
    parts.push(
      `<div class="sec"><b>Out of the shell</b>${holes
        .map((h) => `<div class="hole">&lt;${escape(h.component)}&gt; - ${escape(h.reason)}</div>`)
        .join('')}</div>`,
    )
  }

  const treemapItems = [
    ...Object.entries(route.modules).map(([label, value]) => ({ label, value })),
    ...Object.entries(route.dependencies).map(([label, value]) => ({ label, value })),
    // Bytes nothing accounts for are an absence of information, not a large
    // module, so they are the one cell painted outside the size ramp.
    ...(route.unattributedBytes > 0
      ? [{ label: '(unattributed)', value: route.unattributedBytes, color: 'var(--tm-none)' }]
      : []),
  ]
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
  if (treemapItems.length > 0) {
    parts.push(
      '<div class="sec"><div class="tm-head"><b>Bundle composition</b>' +
      '<span class="tm-scale">smaller <i aria-hidden="true"></i> larger</span></div>' +
      renderTreemapSvg(treemapItems.slice(0, 24)) +
      '</div>',
    )
  }

  // Three lists stacked make a drawer nobody scrolls to the end of; side by side
  // they are one glance. The grid collapses back to a column under ~560px.
  const columns: string[] = []

  const modules = Object.entries(route.modules).slice(0, 12)
  if (modules.length > 0) {
    columns.push(
      `<div class="sec"><b>Your code in this bundle</b>${modules
        .map(([file, bytes]) => `<div class="mod"><code class="path" title="${escape(file)}">${escape(file)}</code><span>${kb(bytes)}</span></div>`)
        .join('')}</div>`,
    )
  }

  const deps = Object.entries(route.dependencies).slice(0, 8)
  if (deps.length > 0) {
    columns.push(
      `<div class="sec"><b>Dependencies</b>${deps
        .map(([pkg, bytes]) => `<div class="mod"><code>${escape(pkg)}</code><span>${kb(bytes)}</span></div>`)
        .join('')}</div>`,
    )
  }

  if (route.clientBoundaries.length > 0) {
    columns.push(
      `<div class="sec"><b>Client boundaries</b>${route.clientBoundaries
        .map(
          (boundary) =>
            `<div class="mod"><code class="path" title="${escape(boundary.file)}">${escape(
              boundary.component ? `<${boundary.component}>` : boundary.file,
            )}</code><span>${kb(boundary.bytes)}</span></div>`,
        )
        .join('')}</div>`,
    )
  }

  if (columns.length > 0) parts.push(`<div class="cols">${columns.join('')}</div>`)

  // What the import style costs, separately from what any component costs.
  if (route.barrels.length > 0) {
    parts.push(
      `<div class="sec"><b>Barrel imports</b>${route.barrels
        .map(
          (barrel) =>
            `<div class="mod"><code class="path" title="${escape(barrel.file)}">${escape(barrel.file)}</code>` +
            `<span>${kb(barrel.bytes)} · ${barrel.dragged.length} module${barrel.dragged.length === 1 ? '' : 's'} this route never renders</span></div>`,
        )
        .join('')}</div>`,
    )
  }

  if (route.unattributedBytes > 0) {
    parts.push(`<div class="sec"><b>Unattributed</b>${kb(route.unattributedBytes)} - no mapping covers these bytes</div>`)
  }

  return parts.join('') || '<span class="empty">Nothing further to report.</span>'
}

/**
 * Click- and keyboard-to-expand. Inlined so the report stays a single file with
 * no external assets.
 *
 * The rows carry `role="button"`, which promises keyboard operability that a
 * table row does not provide on its own - only native buttons synthesise a click
 * from Enter and Space - so both keys are handled explicitly.
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
    // Both the route rows and the cause cards carry role="button" on elements
    // that synthesise no click of their own, so both keys are handled here.
    var target = event.target.closest ? event.target.closest('[data-crust-toggle], [data-crust-routes]') : null
    if (!target) return
    event.preventDefault()
    if (target.hasAttribute('data-crust-toggle')) toggle(target)
    else target.click()
  })

  // ── exploration ─────────────────────────────────────────
  // Filter, group and search over rows already in the document. No fetching and
  // no re-rendering: the report is one file that has to keep working from a
  // file:// URL and out of an email attachment.
  var scope = root.querySelector ? root : document
  var search = scope.querySelector('#crust-search')
  var count = scope.querySelector('#crust-count')
  var noMatch = scope.querySelector('#crust-no-match')
  var rows = Array.prototype.slice.call(scope.querySelectorAll('tr.route'))
  if (rows.length === 0) return

  var state = { filter: 'all', group: 'none', query: '', only: null }

  function matches(row) {
    if (state.only && state.only.indexOf(row.getAttribute('data-pattern')) === -1) return false
    if (state.query && row.getAttribute('data-search').indexOf(state.query) === -1) return false
    var mode = row.getAttribute('data-mode')
    if (state.filter === 'dynamic') return mode === 'DYNAMIC'
    if (state.filter === 'partial') return mode === 'PARTIALLY_STATIC'
    if (state.filter === 'heavy') return Number(row.getAttribute('data-bytes')) > 250000
    if (state.filter === 'unattributed') return Number(row.getAttribute('data-unattributed')) > 0.2
    return true
  }

  function apply() {
    var shown = 0
    var tbody = rows[0].parentNode

    // Group headings are rebuilt rather than toggled: which groups are non-empty
    // depends on the filter, and a heading over nothing is worse than none.
    Array.prototype.slice.call(scope.querySelectorAll('tr.grouphead')).forEach(function (head) {
      head.parentNode.removeChild(head)
    })

    var lastGroup = null
    rows.forEach(function (row) {
      var visible = matches(row)
      var detail = row.nextElementSibling
      row.classList.toggle('hidden', !visible)
      if (detail && detail.classList.contains('detail')) detail.classList.toggle('hidden', !visible)
      if (!visible) return
      shown++

      if (state.group === 'none') return
      var key = row.getAttribute('data-' + state.group) || '—'
      if (key === lastGroup) return
      lastGroup = key
      var head = document.createElement('tr')
      head.className = 'grouphead'
      var cell = document.createElement('td')
      cell.setAttribute('colspan', '5')
      cell.textContent = key
      head.appendChild(cell)
      tbody.insertBefore(head, row)
    })

    if (count) {
      count.textContent =
        shown === rows.length
          ? rows.length + ' routes'
          : shown + ' of ' + rows.length + ' routes' + (state.only ? ' · filtered to one shared cause' : '')
    }

    // A column header over blank space is not an answer to "nothing matched".
    if (noMatch) noMatch.classList.toggle('on', shown === 0)

    // Which cause is driving the table, held in the list rather than forgotten
    // the moment the pointer leaves the row that set it.
    Array.prototype.slice.call(scope.querySelectorAll('[data-crust-routes]')).forEach(function (cause) {
      var mine = cause.getAttribute('data-crust-routes')
      cause.setAttribute('aria-pressed', String(!!state.only && state.only.join(' ') === mine))
    })
  }

  function sortForGrouping() {
    if (state.group === 'none') return
    var tbody = rows[0].parentNode
    var pairs = rows.map(function (row) {
      return { row: row, detail: row.nextElementSibling, key: row.getAttribute('data-' + state.group) || '' }
    })
    pairs.sort(function (a, b) {
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })
    pairs.forEach(function (pair) {
      tbody.appendChild(pair.row)
      if (pair.detail && pair.detail.classList.contains('detail')) tbody.appendChild(pair.detail)
    })
    rows = pairs.map(function (pair) { return pair.row })
  }

  if (search) {
    search.addEventListener('input', function () {
      state.query = search.value.trim().toLowerCase()
      state.only = null
      apply()
    })
  }

  function pickChip(chip) {
    var kind = chip.hasAttribute('data-crust-filter') ? 'filter' : 'group'
    state[kind] = chip.getAttribute('data-crust-' + kind)
    if (kind === 'filter') state.only = null
    Array.prototype.slice.call(scope.querySelectorAll('[data-crust-' + kind + ']')).forEach(function (other) {
      var on = other === chip
      other.classList.toggle('on', on)
      other.setAttribute('aria-pressed', String(on))
    })
    if (kind === 'group') sortForGrouping()
    apply()
  }

  scope.addEventListener('click', function (event) {
    var chip = event.target.closest ? event.target.closest('[data-crust-filter], [data-crust-group]') : null
    if (chip) {
      pickChip(chip)
      return
    }

    // A summary figure that names a problem presses the filter that isolates it,
    // rather than leaving the reader to find the matching chip themselves.
    var jump = event.target.closest ? event.target.closest('[data-crust-jump]') : null
    if (jump) {
      var target = scope.querySelector('[data-crust-filter="' + jump.getAttribute('data-crust-jump') + '"]')
      if (target) {
        pickChip(target)
        if (search) search.scrollIntoView({ block: 'nearest' })
      }
      return
    }

    var copy = event.target.closest ? event.target.closest('[data-crust-copy]') : null
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(copy.getAttribute('data-crust-copy'))
      var original = copy.textContent
      copy.textContent = 'Copied'
      setTimeout(function () { copy.textContent = original }, 1200)
      return
    }

    // Clicking a shared cause narrows the table to exactly the routes it reaches.
    var cause = event.target.closest ? event.target.closest('[data-crust-routes]') : null
    if (cause) {
      var patterns = cause.getAttribute('data-crust-routes').split(' ')
      state.only = state.only && state.only.join(' ') === patterns.join(' ') ? null : patterns
      apply()
    }
  })

  apply()
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
/* The page shell, not the report. Everything scoped under .crust is shared
   verbatim with the in-app widget, which renders inside an 820px panel and must
   not inherit a page's margins. */
body { margin: 0; background: #fff; }
.page { max-width: 1160px; margin: 0 auto; padding: 44px 24px 96px; }
@media (max-width: 640px) { .page { padding: 28px 16px 64px; } }
@media (prefers-color-scheme: dark) { body { background: #000; } }
${renderReportStyles()}
</style>
</head>
<body>
<div class="page">${renderReportBody(snapshot)}</div>
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
