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

/** Categorical palette for treemap cells, keyed by index. OKLCH, hue-stepped at constant L/C. */
const CELL_HUES = [255, 150, 70, 210, 25, 310, 180, 100]

export function renderTreemapSvg(items: TreemapItem[], width = 720, height = 220): string {
  const cells = treemapLayout(items, width, height)
  if (cells.length === 0) return ''

  const rects = cells
    .map((cell, index) => {
      const hue = CELL_HUES[index % CELL_HUES.length]!
      const fill = cell.color ?? `oklch(0.72 0.11 ${hue} / 0.55)`
      const showLabel = cell.w > 70 && cell.h > 26
      const label = showLabel
        ? `<text x="${(cell.x + 5).toFixed(1)}" y="${(cell.y + 15).toFixed(1)}" class="tm-label">${escapeXml(
            truncate(cell.label, Math.floor(cell.w / 6)),
          )}</text>` +
          `<text x="${(cell.x + 5).toFixed(1)}" y="${(cell.y + 28).toFixed(1)}" class="tm-value">${kb(cell.value)}</text>`
        : ''
      return (
        `<g><title>${escapeXml(cell.label)} - ${kb(cell.value)}</title>` +
        `<rect x="${cell.x.toFixed(1)}" y="${cell.y.toFixed(1)}" width="${Math.max(0, cell.w - 1.5).toFixed(1)}" height="${Math.max(0, cell.h - 1.5).toFixed(1)}" rx="3" fill="${fill}"/>` +
        label +
        '</g>'
      )
    })
    .join('')

  return (
    `<svg class="treemap" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bundle composition treemap" ` +
    `style="width:100%;height:auto">` +
    `<style>.tm-label{font:600 11px ui-sans-serif,sans-serif;fill:var(--fg)}.tm-value{font:10px ui-monospace,monospace;fill:var(--dim)}</style>` +
    rects +
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
  const trendColor = lastValue > firstValue * 1.02 ? 'var(--bad)' : lastValue < firstValue * 0.98 ? 'var(--static)' : 'var(--dim)'
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
const truncate = (value: string, max: number): string => (value.length > max ? `…${value.slice(-(max - 1))}` : value)

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
