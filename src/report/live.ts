import type { CollectorState } from '../collector/index.ts'

/**
 * Live section for the in-app widget: whatever the runtime collector has
 * observed on the current page. Rendered only when the collector is running —
 * a panel of dashes teaches people the section is dead weight.
 */
export function renderLiveSection(state: CollectorState): string {
  const parts: string[] = ['<div class="sec"><b>Live — this page, this visit</b></div>']

  const v = state.vitals
  parts.push('<div class="stats">')
  parts.push(tile(ms(v?.ttfb), 'TTFB'))
  parts.push(tile(ms(v?.fcp), 'FCP'))
  parts.push(tile(ms(v?.lcp), 'LCP', v?.lcp != null && v.lcp > 2500))
  parts.push(tile(v ? v.cls.toFixed(3) : '—', 'CLS', v != null && v.cls > 0.1))
  parts.push(tile(ms(v?.inp), 'INP', v?.inp != null && v.inp > 200))
  parts.push(tile(ms(state.loaf?.totalBlockingTime), 'LoAF TBT', (state.loaf?.totalBlockingTime ?? 0) > 300))
  parts.push('</div>')

  if (v?.lcpElement) {
    parts.push(`<div class="sub">LCP element: <code>${escape(v.lcpElement)}</code></div>`)
  }

  const streaming = state.streaming
  if (streaming?.supported && streaming.fills.length > 0) {
    const timed = streaming.fills.filter((f) => f.filledAt !== null)
    const last = timed.length > 0 ? Math.max(...timed.map((f) => f.filledAt!)) : 0
    parts.push('<div class="sec"><b>Streaming — when each hole filled</b>')
    for (const fill of streaming.fills) {
      const width = fill.filledAt !== null && last > 0 ? Math.max(2, (fill.filledAt / last) * 100) : 2
      parts.push(
        `<div class="mod"><span class="fill-bar"><i style="width:${width.toFixed(1)}%"></i></span>` +
          `<span><code>${escape(fill.boundaryId)}</code> ${fill.filledAt === null ? 'before collector start' : ms(fill.filledAt)}</span></div>`,
      )
    }
    parts.push('</div>')
  } else if (streaming && !streaming.supported && streaming.reason) {
    parts.push(`<div class="sub">${escape(streaming.reason)}</div>`)
  }

  if (state.images.length > 0) {
    parts.push(`<div class="sec"><b>Image audit — ${state.images.length} finding(s)</b>`)
    for (const finding of state.images.slice(0, 8)) {
      parts.push(
        `<div class="hole"><code>${escape(finding.element)}</code> — ${escape(finding.message)}</div>`,
      )
    }
    if (state.images.length > 8) parts.push(`<div class="sub">… ${state.images.length - 8} more</div>`)
    parts.push('</div>')
  }

  // The `.crust` wrapper is not decoration: every rule in the shared stylesheet
  // is scoped under it, so a bare `.live` block inherits the host page's fonts
  // and colors and renders as unstyled text.
  return `<div class="crust"><div class="live">${parts.join('')}</div></div>`
}

export function renderLiveStyles(): string {
  return `
.crust .live { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 4px; }
.crust .live .stats { margin-top: 8px; border-top: 0; }
.crust .stat.warn b { color: var(--red); }
.crust .fill-bar { display: inline-block; width: 140px; height: 4px; border-radius: 2px;
  background: var(--border); overflow: hidden; vertical-align: middle; }
.crust .fill-bar i { display: block; height: 100%; border-radius: 2px; background: var(--blue); }
`.trim()
}

function tile(value: string, label: string, warn = false): string {
  return `<div class="stat${warn ? ' warn' : ''}"><b>${value}</b><span>${label}</span></div>`
}

const ms = (value: number | null | undefined): string => (value == null ? '—' : `${Math.round(value)} ms`)

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
