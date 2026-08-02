/**
 * Treemap and sparkline as inline SVG strings.
 *
 * Not d3: the layout is the only part of d3-hierarchy the report needs, it is
 * ~50 lines, and every dependency here ships into the user's page through the
 * widget (plan §7's dependency discipline).
 */

export interface TreemapItem {
  label: string
  value: number
  /** CSS color; falls back to the series palette when omitted. */
  color?: string
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): lay rows along the shorter
 * side, adding items while the worst aspect ratio in the row improves.
 */
export function treemapLayout(items: TreemapItem[], width: number, height: number): (TreemapItem & Rect)[] {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  if (total <= 0 || items.length === 0) return []

  const sorted = [...items].sort((a, b) => b.value - a.value)
  const scale = (width * height) / total
  const out: (TreemapItem & Rect)[] = []

  let rect: Rect = { x: 0, y: 0, w: width, h: height }
  let row: TreemapItem[] = []

  const worst = (areas: number[], side: number): number => {
    const sum = areas.reduce((a, b) => a + b, 0)
    const max = Math.max(...areas)
    const min = Math.min(...areas)
    const sideSq = side * side
    return Math.max((sideSq * max) / (sum * sum), (sum * sum) / (sideSq * min))
  }

  const layoutRow = (finalRow: TreemapItem[]): void => {
    const rowArea = finalRow.reduce((sum, item) => sum + item.value * scale, 0)
    const horizontal = rect.w >= rect.h
    const side = horizontal ? rect.h : rect.w
    const thickness = side > 0 ? rowArea / side : 0
    let offset = 0

    for (const item of finalRow) {
      const length = side > 0 ? (item.value * scale) / thickness : 0
      out.push(
        horizontal
          ? { ...item, x: rect.x, y: rect.y + offset, w: thickness, h: length }
          : { ...item, x: rect.x + offset, y: rect.y, w: length, h: thickness },
      )
      offset += length
    }

    rect = horizontal
      ? { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h }
      : { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness }
  }

  for (const item of sorted) {
    const side = Math.min(rect.w, rect.h)
    const candidate = [...row, item]
    const areas = candidate.map((i) => i.value * scale)
    if (row.length === 0 || worst(areas, side) <= worst(row.map((i) => i.value * scale), side)) {
      row = candidate
    } else {
      layoutRow(row)
      row = [item]
    }
  }
  if (row.length > 0) layoutRow(row)

  return out
}

export function renderTreemapSvg(items: TreemapItem[], width = 720, height = 220): string {
  const cells = treemapLayout(items, width, height)
  if (cells.length === 0) return ''

  const values = cells.map((cell) => cell.value)
  const minLog = Math.log1p(Math.min(...values))
  const maxLog = Math.log1p(Math.max(...values))
  const logRange = maxLog - minLog || 1
  const keyed: { index: number; label: string; value: number }[] = []

  const rects = cells
    .map((cell, index) => {
      // Area already communicates absolute size, so colour is a reinforcement
      // and nothing more. It runs one hue and varies lightness and chroma:
      // a full cool-to-warm sweep put five hues on the surface for one
      // sequential variable, and painted the small modules green, which reads
      // as a verdict the treemap is not making. Log scaling keeps the middle of
      // a skewed bundle distinguishable.
      const size = (Math.log1p(cell.value) - minLog) / logRange
      const canName = cell.w >= 28 && cell.h >= 16
      const canValue = cell.w >= 48 && cell.h >= 31
      const key = index + 1
      if (!canName) keyed.push({ index: key, label: cell.label, value: cell.value })

      const clipId = `tm-clip-${index}`
      const visibleName = canName
        ? truncate(compactLabel(cell.label), Math.max(2, Math.floor((cell.w - 10) / 6)))
        : `#${key}`
      const labelY = canValue ? cell.y + 15 : cell.y + Math.max(11, cell.h / 2 + 4)
      const labelX = canName ? cell.x + 5 : cell.x + cell.w / 2
      const label =
        `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" class="tm-label${canName ? '' : ' tm-index'}"${canName ? '' : ' text-anchor="middle"'} clip-path="url(#${clipId})">${escapeXml(visibleName)}</text>` +
        (canValue
          ? `<text x="${(cell.x + 5).toFixed(1)}" y="${(cell.y + 28).toFixed(1)}" class="tm-value" clip-path="url(#${clipId})">${kb(cell.value)}</text>`
          : '')
      // As a custom property, not a `fill` attribute: presentation attributes
      // lose to any CSS declaration, and `.tm-cell` sets `fill` for the ramp, so
      // an override written as an attribute is silently ignored.
      const fill = cell.color ? `;--tm-fill:${escapeXml(cell.color)}` : ''
      return (
        `<g class="tm-group" tabindex="0" role="img" aria-label="${escapeXml(cell.label)} — ${kb(cell.value)}" style="--tm-size:${size.toFixed(3)}${fill}">` +
        `<title>${escapeXml(cell.label)} — ${kb(cell.value)}</title>` +
        `<clipPath id="${clipId}"><rect x="${(cell.x + 3).toFixed(1)}" y="${(cell.y + 3).toFixed(1)}" width="${Math.max(0, cell.w - 7).toFixed(1)}" height="${Math.max(0, cell.h - 7).toFixed(1)}" rx="2"/></clipPath>` +
        `<rect class="tm-cell" x="${cell.x.toFixed(1)}" y="${cell.y.toFixed(1)}" width="${Math.max(0, cell.w - 2).toFixed(1)}" height="${Math.max(0, cell.h - 2).toFixed(1)}" rx="4"/>` +
        label +
        '</g>'
      )
    })
    .join('')

  const keyColumns = width >= 600 ? 3 : width >= 360 ? 2 : 1
  const keyRows = keyed.length > 0 ? Math.ceil(keyed.length / keyColumns) : 0
  const keyHeight = keyRows > 0 ? 26 + keyRows * 17 : 0
  const keyWidth = width / keyColumns
  const keyItems = keyed
    .map((item, index) => {
      const column = index % keyColumns
      const row = Math.floor(index / keyColumns)
      const x = column * keyWidth
      const y = height + 25 + row * 17
      const available = Math.max(4, Math.floor((keyWidth - 70) / 6))
      return (
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="tm-key-index">#${item.index}</text>` +
        `<text x="${(x + 24).toFixed(1)}" y="${y.toFixed(1)}" class="tm-key-label">${escapeXml(truncate(compactLabel(item.label), available))}</text>` +
        `<text x="${(x + keyWidth - 6).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" class="tm-key-value">${kb(item.value)}</text>`
      )
    })
    .join('')
  const key = keyed.length > 0
    ? `<line x1="0" y1="${(height + 10).toFixed(1)}" x2="${width}" y2="${(height + 10).toFixed(1)}" class="tm-rule"/>` + keyItems
    : ''

  return (
    `<svg class="treemap" viewBox="0 0 ${width} ${height + keyHeight}" role="img" aria-label="Bundle composition treemap. Color runs from cool for smaller modules to warm for larger modules." ` +
    `style="width:100%;height:auto">` +
    `<style>
      .treemap{--tm-none:oklch(.90 0 0)}
      .tm-cell{fill:var(--tm-fill, oklch(calc(.93 - var(--tm-size) * .25) calc(.02 + var(--tm-size) * .11) 254));stroke:var(--bg);stroke-width:1.5;transition:filter 120ms ease,stroke 120ms ease}
      .tm-label{font:600 11px ui-sans-serif,sans-serif;fill:oklch(.22 0 0);pointer-events:none}
      .tm-index{font-size:8px}
      .tm-value{font:10px ui-monospace,monospace;fill:oklch(.36 0 0);pointer-events:none}
      .tm-group:hover .tm-cell,.tm-group:focus-visible .tm-cell{filter:brightness(1.05);stroke:var(--fg);stroke-width:2}
      .tm-group:focus{outline:none}
      .tm-rule{stroke:var(--border);stroke-width:1}
      .tm-key-index{font:600 9px ui-monospace,monospace;fill:var(--fg)}
      .tm-key-label,.tm-key-value{font:9px ui-monospace,monospace;fill:var(--muted)}
      @media(prefers-color-scheme:dark){
        .treemap{--tm-none:oklch(.30 0 0)}
        .tm-cell{fill:var(--tm-fill, oklch(calc(.26 + var(--tm-size) * .26) calc(.03 + var(--tm-size) * .11) 254))}
        .tm-label{fill:oklch(.97 0 0)}.tm-value{fill:oklch(.84 0 0)}
      }
      @media(prefers-reduced-motion:reduce){.tm-cell{transition:none}}
    </style>` +
    rects +
    key +
    '</svg>'
  )
}

/**
 * Per-route trend as a tiny inline SVG. Points are equal-spaced by build, not by
 * time - the question the sparkline answers is "which change moved it", and
 * builds are the unit of change.
 */
export function renderSparklineSvg(values: number[], width = 96, height = 22): string {
  if (values.length < 2) return ''

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pad = 2

  const points = values
    .map((value, index) => {
      const x = pad + (index / (values.length - 1)) * (width - pad * 2)
      const y = pad + (1 - (value - min) / range) * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const lastValue = values[values.length - 1]!
  const firstValue = values[0]!
  // These have to be variables the stylesheet actually defines. `--bad`,
  // `--static` and `--dim` were not among them, so `stroke` was invalid at
  // computed-value time and every sparkline in the report drew nothing but its
  // end dot.
  const trendColor =
    lastValue > firstValue * 1.02 ? 'var(--red)' : lastValue < firstValue * 0.98 ? 'var(--green)' : 'var(--faint)'
  const [lastX, lastY] = points.split(' ').pop()!.split(',')

  return (
    `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend over the last ${values.length} builds" ` +
    `style="width:${width}px;height:${height}px">` +
    `<polyline points="${points}" fill="none" stroke="${trendColor}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<circle cx="${lastX}" cy="${lastY}" r="2" fill="${trendColor}"/>` +
    '</svg>'
  )
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`
const truncate = (value: string, max: number): string => {
  if (max <= 1) return value.slice(0, Math.max(0, max))
  return value.length > max ? `…${value.slice(-(max - 1))}` : value
}

const compactLabel = (value: string): string => {
  const segments = value.split('/')
  return segments[segments.length - 1] || value
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
