import type { ReactNode } from 'react'

/**
 * The four drawings.
 *
 * The page had a good written argument and no picture of it, which is a
 * problem for the two claims that are about *shape* rather than about value: a
 * comparison needs two builds to exist before it can happen, and one cause can
 * be a finding on nineteen routes at once. Prose can assert both. Neither is
 * obvious from a sentence.
 *
 * Everything here is server-rendered SVG with no script and no images. Colours
 * come from the same custom properties the rest of the page uses, so a diagram
 * follows the light and dark themes for free, and text is real `<text>` so it
 * stays selectable and searchable.
 *
 * On the sizing: each figure is authored against a fixed viewBox and given a
 * `min-width`, then wrapped in a horizontal scroller. Letting an SVG scale to a
 * 360px phone would take 12px labels down to 5px, and the honest options are to
 * redraw every diagram twice or to let it scroll — the page already chose
 * scrolling for its route table, so these match it.
 */

const HAIRLINE = 1.5

function Figure({
  caption,
  title,
  minWidth,
  viewBox,
  children,
}: {
  caption: ReactNode
  title: string
  minWidth: number
  viewBox: string
  children: ReactNode
}) {
  return (
    /* `min-w-0` on both the figure and its scroller: a grid or flex item
       defaults to `min-width: auto`, which is the SVG's own min-width, so
       without this the diagram widens its container instead of scrolling
       inside it — and on a phone that stretches the whole page. */
    <figure className="m-0 min-w-0">
      <div className="min-w-0 overflow-x-auto">
        <svg
          viewBox={viewBox}
          role="img"
          aria-label={title}
          className="block h-auto w-full"
          style={{ minWidth }}
        >
          <title>{title}</title>
          {children}
        </svg>
      </div>
      <figcaption className="mt-4 text-meta leading-[1.65] text-faint text-pretty">
        {caption}
      </figcaption>
    </figure>
  )
}

/** A connector that ends in an arrowhead. Every arrow here arrives horizontally. */
function Arrow({
  from,
  to,
  curve = 0,
  tone = 'var(--border)',
  head = true,
}: {
  from: [number, number]
  to: [number, number]
  curve?: number
  tone?: string
  head?: boolean
}) {
  const [x1, y1] = from
  const [x2, y2] = to
  const d = curve
    ? `M${x1} ${y1} C${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`
    : `M${x1} ${y1} L${x2} ${y2}`

  return (
    <g>
      <path d={d} fill="none" stroke={tone} strokeWidth={HAIRLINE} />
      {head ? (
        <path
          d="M-5 -3.5 L0 0 L-5 3.5"
          fill="none"
          stroke={tone}
          strokeWidth={HAIRLINE}
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`translate(${x2} ${y2})`}
        />
      ) : null}
    </g>
  )
}

/** A rounded node with a value and an uppercase caption under it. */
function Node({
  x,
  y,
  w,
  h,
  title,
  sub,
  tone,
  code = false,
  size = 14,
}: {
  x: number
  y: number
  w: number
  h: number
  title: string
  sub?: string
  tone?: string
  code?: boolean
  size?: number
}) {
  const cx = x + w / 2
  const cy = y + h / 2
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill="var(--surface)"
        stroke={tone ?? 'var(--border)'}
        strokeWidth={HAIRLINE}
      />
      <text
        x={cx}
        y={sub ? cy - 5 : cy}
        textAnchor="middle"
        dominantBaseline="middle"
        className={code ? 'font-mono' : 'font-sans'}
        style={{ fontSize: size, fontWeight: 550 }}
        fill={tone ?? 'var(--fg)'}
      >
        {title}
      </text>
      {sub ? (
        <text
          x={cx}
          y={cy + 15}
          textAnchor="middle"
          dominantBaseline="middle"
          className="font-sans"
          style={{ fontSize: 10, letterSpacing: '0.07em' }}
          fill="var(--faint)"
        >
          {sub.toUpperCase()}
        </text>
      ) : null}
    </g>
  )
}

/* -------------------------------------------------------------------------- */

const ARTIFACTS = [
  '.next/app-build-manifest.json',
  '.next/prerender-manifest.json',
  '.next/server/app/**',
  '.next/static/chunks/*.js.map',
]

const ROW_H = 30
const ROW_GAP = 8
const COL_TOP = 18
const AXIS = COL_TOP + (ARTIFACTS.length * (ROW_H + ROW_GAP) - ROW_GAP) / 2

/**
 * Where the evidence comes from.
 *
 * The point of naming the actual files is that it bounds the magic. crust does
 * not run the app, instrument it or score it; it opens four things `next build`
 * already wrote and turns them into one record.
 */
export function SnapshotDiagram() {
  return (
    <Figure
      title="A production build is read into one snapshot, stored on a branch in your repository"
      viewBox="0 0 900 182"
      minWidth={780}
      caption={
        <>
          Nothing is instrumented, re-run or scored. The same build always produces the same
          snapshot, and the snapshot lives on a conflict-free history branch beside your code.
        </>
      }
    >
      {ARTIFACTS.map((file, i) => {
        const y = COL_TOP + i * (ROW_H + ROW_GAP)
        return (
          <g key={file}>
            <rect
              x={0}
              y={y}
              width={236}
              height={ROW_H}
              rx={7}
              fill="var(--surface)"
              stroke="var(--border)"
              strokeWidth={HAIRLINE}
            />
            <text
              x={14}
              y={y + ROW_H / 2}
              dominantBaseline="middle"
              className="font-mono"
              style={{ fontSize: 11 }}
              fill="var(--muted)"
            >
              {file}
            </text>
            <Arrow from={[236, y + ROW_H / 2]} to={[304, AXIS]} curve={40} head={false} />
          </g>
        )
      })}

      <Node x={306} y={AXIS - 36} w={132} h={72} title="crust" sub="fixed rules" />
      <Arrow from={[438, AXIS]} to={[492, AXIS]} tone="var(--faint)" />
      <Node x={494} y={AXIS - 36} w={160} h={72} title="snapshot" sub="one record" />
      <Arrow from={[654, AXIS]} to={[704, AXIS]} tone="var(--faint)" />
      <Node
        x={706}
        y={AXIS - 36}
        w={194}
        h={72}
        title="perf-history"
        sub="your repository"
        code
        tone="var(--green)"
      />
    </Figure>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Two refs, one comparison, one decision.
 *
 * This is the drawing the page most needed. "Compare two production builds" is
 * a sentence people read as "analyse my build", and the difference between
 * those two things is the entire product: the base is not rebuilt, not checked
 * out, and not inferred — it is a snapshot that was recorded when it was the
 * head, and it is still sitting on the branch.
 */
const MAIN_Y = 128
const FEATURE_Y = 52

export function DiffDiagram() {
  return (
    <Figure
      title="Two stored snapshots are compared and produce one decision"
      viewBox="0 0 900 176"
      minWidth={780}
      caption={
        <>
          Any two refs — branches, tags, commits or build ids. Because both sides come from the
          store, neither one is checked out and neither one is built a second time.
        </>
      }
    >
      {/* main */}
      <path
        d={`M24 ${MAIN_Y} H286`}
        fill="none"
        stroke="var(--border)"
        strokeWidth={HAIRLINE + 0.5}
      />
      {[34, 110, 186].map((x) => (
        <circle
          key={x}
          cx={x}
          cy={MAIN_Y}
          r={6}
          fill="var(--bg)"
          stroke="var(--faint)"
          strokeWidth={2}
        />
      ))}
      <circle cx={262} cy={MAIN_Y} r={6} fill="var(--fg)" stroke="var(--fg)" strokeWidth={2} />
      <text
        x={262}
        y={MAIN_Y + 22}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 11 }}
        fill="var(--faint)"
      >
        cfdcf500
      </text>
      <text
        x={262}
        y={MAIN_Y + 40}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 12, fontWeight: 550 }}
        fill="var(--fg)"
      >
        main
      </text>

      {/* the branch leaves main and climbs */}
      <path
        d={`M110 ${MAIN_Y} C150 ${MAIN_Y}, 146 ${FEATURE_Y}, 186 ${FEATURE_Y} H286`}
        fill="none"
        stroke="var(--border)"
        strokeWidth={HAIRLINE + 0.5}
      />
      <circle
        cx={186}
        cy={FEATURE_Y}
        r={6}
        fill="var(--bg)"
        stroke="var(--blue)"
        strokeWidth={2}
      />
      <circle cx={262} cy={FEATURE_Y} r={6} fill="var(--blue)" stroke="var(--blue)" strokeWidth={2} />
      <text
        x={262}
        y={FEATURE_Y - 14}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 11 }}
        fill="var(--faint)"
      >
        4a802397
      </text>
      <text
        x={262}
        y={FEATURE_Y - 32}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 12, fontWeight: 550 }}
        fill="var(--blue)"
      >
        feature
      </text>

      <Arrow from={[290, MAIN_Y]} to={[398, 102]} curve={54} tone="var(--faint)" />
      <Arrow from={[290, FEATURE_Y]} to={[398, 78]} curve={54} tone="var(--faint)" />

      <Node x={400} y={52} w={170} h={76} title="crust diff" sub="base → head" />
      <Arrow from={[570, 90]} to={[616, 90]} tone="var(--faint)" />

      <rect
        x={618}
        y={52}
        width={282}
        height={76}
        rx={8}
        fill="var(--surface)"
        stroke="var(--red)"
        strokeWidth={HAIRLINE}
      />
      <text x={636} y={78} className="font-sans" style={{ fontSize: 15, fontWeight: 600 }} fill="var(--red)">
        BLOCK
      </text>
      <text x={636} y={98} className="font-mono" style={{ fontSize: 11 }} fill="var(--muted)">
        /products/[slug] is no longer static
      </text>
      <text x={636} y={114} className="font-sans" style={{ fontSize: 10, letterSpacing: '0.07em' }} fill="var(--faint)">
        ATTRIBUTION 94%
      </text>
    </Figure>
  )
}

/* -------------------------------------------------------------------------- */

const HOPS: { kind: string; value: string; code: boolean; tone?: string }[] = [
  { kind: 'route', value: '/products/[slug]', code: true, tone: 'var(--blue)' },
  { kind: 'component', value: '<ProductGallery>', code: false },
  { kind: 'binding', value: 'getProduct()', code: true },
  { kind: 'import', value: 'lib/http.ts', code: true },
  { kind: 'call site', value: 'lib/http.ts:3', code: true, tone: 'var(--red)' },
]

const HOP_W = 156
const HOP_GAP = 30

/**
 * The chain, drawn end to end.
 *
 * "Traces regressions to the component, import and source line" is four nouns
 * in a sentence and five boxes with arrows between them on screen, and only one
 * of those makes it obvious that each hop is *derived from* the one before it.
 */
export function ChainDiagram() {
  return (
    <Figure
      title="A cause chain from route to the source line that introduced the regression"
      viewBox="0 0 900 152"
      minWidth={780}
      caption={
        <>
          Each hop is derived from the one before it. When a hop cannot be established, crust
          reports it as unknown rather than naming a plausible file — a wrong blame costs more than
          no blame.
        </>
      }
    >
      {HOPS.map((hop, i) => {
        const x = i * (HOP_W + HOP_GAP)
        return (
          <g key={hop.kind}>
            <text
              x={x}
              y={12}
              className="font-sans"
              style={{ fontSize: 10, letterSpacing: '0.07em' }}
              fill="var(--faint)"
            >
              {hop.kind.toUpperCase()}
            </text>
            <rect
              x={x}
              y={22}
              width={HOP_W}
              height={58}
              rx={8}
              fill="var(--surface)"
              stroke={hop.tone === 'var(--red)' ? 'var(--red)' : 'var(--border)'}
              strokeWidth={HAIRLINE}
            />
            <text
              x={x + HOP_W / 2}
              y={51}
              textAnchor="middle"
              dominantBaseline="middle"
              className={hop.code ? 'font-mono' : 'font-sans'}
              style={{ fontSize: 12, fontWeight: hop.code ? 400 : 600 }}
              fill={hop.tone ?? 'var(--fg)'}
            >
              {hop.value}
            </text>
            {i < HOPS.length - 1 ? (
              <Arrow from={[x + HOP_W, 51]} to={[x + HOP_W + HOP_GAP - 4, 51]} />
            ) : null}
          </g>
        )
      })}

      <text
        x={4 * (HOP_W + HOP_GAP) + HOP_W / 2}
        y={98}
        textAnchor="middle"
        className="font-sans"
        style={{ fontSize: 11 }}
        fill="var(--red)"
      >
        uncached fetch
      </text>

      <circle cx={5} cy={130} r={4} fill="var(--green)" />
      <text x={18} y={134} className="font-sans" style={{ fontSize: 12 }} fill="var(--green)">
        Cache that read and the route can prerender again — verified evidence
      </text>
    </Figure>
  )
}

/* -------------------------------------------------------------------------- */

const AFFECTED = [
  '/products/[slug]',
  '/checkout',
  '/analytics',
  '/account',
  '/orders/[id]',
  '/search',
  '/cart',
  '/wishlist',
  '/settings',
]

const FAN_STEP = 24
const FAN_TOP = 12
const FAN_AXIS = FAN_TOP + ((AFFECTED.length - 1) * FAN_STEP) / 2

/**
 * One cause, and everything it reaches.
 *
 * A tool that reports per route prints this finding nine times and leaves the
 * reader to work out that it is one edit. The fan is the whole argument for
 * grouping: the shape says "one thing, nine consequences" before a single label
 * has been read.
 */
export function BlastDiagram() {
  return (
    <Figure
      title="One package regression grouped once, with the nine routes it affects"
      viewBox="0 0 900 224"
      minWidth={780}
      caption={
        <>
          Packages, client boundaries, barrel imports and call sites are grouped once. One decision
          with a nine-route blast radius, not nine copies of the same finding.
        </>
      }
    >
      <rect
        x={0}
        y={FAN_AXIS - 44}
        width={268}
        height={88}
        rx={8}
        fill="var(--surface)"
        stroke="var(--red)"
        strokeWidth={HAIRLINE}
      />
      <text
        x={18}
        y={FAN_AXIS - 20}
        className="font-sans"
        style={{ fontSize: 10, letterSpacing: '0.07em' }}
        fill="var(--faint)"
      >
        PACKAGE
      </text>
      <text x={18} y={FAN_AXIS + 6} className="font-mono" style={{ fontSize: 16 }} fill="var(--fg)">
        date-fns
      </text>
      <text x={18} y={FAN_AXIS + 28} className="font-mono" style={{ fontSize: 11 }} fill="var(--red)">
        added · +48.2 kB first load
      </text>

      <text x={0} y={FAN_AXIS + 84} className="font-mono" style={{ fontSize: 28 }} fill="var(--fg)">
        {AFFECTED.length}
      </text>
      <text
        x={0}
        y={FAN_AXIS + 102}
        className="font-sans"
        style={{ fontSize: 10, letterSpacing: '0.07em' }}
        fill="var(--faint)"
      >
        ROUTES AFFECTED
      </text>

      {AFFECTED.map((route, i) => {
        /* The route column sits well clear of the cause box so the connectors
           have room to spread. Drawn any closer they run parallel and the fan
           reads as a brace holding a list, which is the opposite of the point. */
        const y = FAN_TOP + i * FAN_STEP
        return (
          <g key={route}>
            <Arrow from={[268, FAN_AXIS]} to={[418, y]} curve={86} head={false} />
            <circle cx={428} cy={y} r={3.5} fill="var(--faint)" />
            <text
              x={444}
              y={y}
              dominantBaseline="middle"
              className="font-mono"
              style={{ fontSize: 12 }}
              fill={i === 0 ? 'var(--blue)' : 'var(--muted)'}
            >
              {route}
            </text>
            <text
              x={900}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              className="font-mono"
              style={{ fontSize: 11 }}
              fill="var(--faint)"
            >
              +48.2 kB
            </text>
          </g>
        )
      })}
    </Figure>
  )
}
