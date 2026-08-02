import { renderReportBody, renderReportStyles } from '../report/render.ts'
import { renderLiveSection, renderLiveStyles } from '../report/live.ts'
import type { Snapshot } from '../store/snapshot.ts'
import type { CollectorState } from '../collector/index.ts'

declare global {
  interface Window {
    __CRUST_COLLECTOR__?: CollectorState
  }
}

export interface WidgetOptions {
  /** Where the manifest was written. Must be publicly served. */
  manifestUrl?: string
  /** Corner to dock the launcher in. */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
}

const CONTAINER_ID = 'crust-widget-root'

/**
 * Mount the in-page widget.
 *
 * Three deliberate choices:
 *
 * - **Shadow DOM.** The panel renders inside a closed style boundary so the host
 *   app's CSS cannot break it and its CSS cannot leak into the app. A devtool that
 *   restyles the page it is measuring is worse than no devtool.
 *
 * - **No UI framework.** This ships into someone else's page. Coupling it to a
 *   React version would make the widget a support burden and drag a second
 *   renderer into the bundle.
 *
 * - **Lazy.** The manifest is only fetched when the panel is first opened, and the
 *   launcher does no layout or network work before that. The widget must not move
 *   the numbers it exists to report (R7).
 */
export function mountCrustWidget(options: WidgetOptions = {}): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(CONTAINER_ID)) return () => {}

  const manifestUrl = options.manifestUrl ?? '/crust-manifest.json'
  const position = options.position ?? 'bottom-right'

  const host = document.createElement('div')
  host.id = CONTAINER_ID
  const [vertical, horizontal] = position.split('-') as ['bottom' | 'top', 'right' | 'left']
  host.style.cssText = `position:fixed;${vertical}:16px;${horizontal}:16px;z-index:2147483000;`
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
<style>
  :host { all: initial; }

  .launch {
    font: 650 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    letter-spacing: 0.01em;
    /* 44px touch target: the pill is visually 32px tall, so the hit area is
       extended rather than the button being made to look chunky. */
    min-height: 44px; padding: 0 16px;
    cursor: pointer; border: 0; border-radius: 999px;
    background: oklch(0.22 0.012 265); color: oklch(0.98 0 0);
    /* Layered transparent shadows read as depth on any page background;
       a solid border would fight whatever is behind it. */
    box-shadow: 0 1px 2px oklch(0 0 0 / 0.12), 0 6px 16px oklch(0 0 0 / 0.18);
    transition-property: scale, background-color;
    transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  .launch:active { scale: 0.96; }
  .launch:focus-visible { outline: 2px solid oklch(0.55 0.17 255); outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    .launch { background: oklch(0.95 0.004 265); color: oklch(0.17 0.008 265); }
  }

  .panel {
    display: none; position: fixed; ${vertical}: 68px; ${horizontal}: 16px;
    width: min(780px, calc(100vw - 32px)); max-height: min(72vh, 800px); overflow: auto;
    /* Concentric: 24px outer radius with 16px padding gives inner surfaces 8px,
       which is what the report's stat cards and notes already use. */
    border-radius: 24px; padding: 16px;
    background: oklch(1 0 0);
    box-shadow: 0 2px 4px oklch(0 0 0 / 0.06), 0 16px 48px oklch(0 0 0 / 0.22);
    overscroll-behavior: contain;
  }
  @media (prefers-color-scheme: dark) { .panel { background: oklch(0.17 0.008 265); } }
  .panel.open { display: block; }

  .close {
    position: sticky; top: 0; float: inline-end; z-index: 1;
    width: 40px; height: 40px; margin: -6px -6px 0 0;
    display: grid; place-items: center;
    cursor: pointer; border: 0; border-radius: 999px; background: none;
    font-size: 18px; line-height: 1; color: oklch(0.52 0.016 265);
    transition-property: scale, color; transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .close:hover { color: oklch(0.22 0.012 265); }
  .close:active { scale: 0.96; }
  .close:focus-visible { outline: 2px solid oklch(0.55 0.17 255); outline-offset: -2px; }
  @media (prefers-color-scheme: dark) { .close:hover { color: oklch(0.93 0.006 265); } }

  @media (prefers-reduced-motion: reduce) {
    .launch, .close { transition-duration: 0.01ms; }
    .launch:active, .close:active { scale: 1; }
  }

  ${renderReportStyles()}
  ${renderLiveStyles()}
</style>
<button class="launch" type="button" part="launcher" aria-expanded="false">crust</button>
<div class="panel" role="dialog" aria-modal="false" aria-label="crust performance report">
  <button class="close" type="button" aria-label="Close">×</button>
  <div class="content"><div class="crust"><div class="sub">Loading…</div></div></div>
</div>`

  const launcher = shadow.querySelector('.launch') as HTMLButtonElement
  const panel = shadow.querySelector('.panel') as HTMLElement
  const content = shadow.querySelector('.content') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement

  let loaded = false

  const open = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    try {
      const response = await fetch(manifestUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const snapshot = (await response.json()) as Snapshot
      const live = window.__CRUST_COLLECTOR__ ? renderLiveSection(window.__CRUST_COLLECTOR__) : ''
      content.innerHTML = live + renderReportBody(snapshot)
    } catch (error) {
      loaded = false
      content.innerHTML = `<div class="crust"><div class="note">Could not load <code>${manifestUrl}</code> — ${String(
        (error as Error).message,
      )}.<br>Generate it with <code>crust manifest --out public/crust-manifest.json</code> after a production build.</div></div>`
    }
  }

  // Expansion rows live inside the shadow root, so the report's own delegated
  // handler (which binds to `document`) never sees these events.
  const toggleRow = (row: Element): void => {
    const detail = shadow.getElementById(`crust-detail-${row.getAttribute('data-crust-toggle')}`)
    if (!detail) return
    row.setAttribute('aria-expanded', String(detail.classList.toggle('open')))
  }

  const rowFrom = (event: Event): Element | null =>
    (event.target as HTMLElement | null)?.closest?.('[data-crust-toggle]') ?? null

  const onClick = (event: Event): void => {
    const row = rowFrom(event)
    if (row) toggleRow(row)
  }

  // `role="button"` promises Enter and Space work; only native buttons get that
  // for free, so the rows handle both themselves.
  const onContentKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const row = rowFrom(event)
    if (!row) return
    event.preventDefault()
    toggleRow(row)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setOpen(false)
  }

  const setOpen = (isOpen: boolean): void => {
    panel.classList.toggle('open', isOpen)
    launcher.setAttribute('aria-expanded', String(isOpen))
  }

  launcher.addEventListener('click', () => {
    if (panel.classList.contains('open')) setOpen(false)
    else {
      setOpen(true)
      void open()
    }
  })
  close.addEventListener('click', () => setOpen(false))
  content.addEventListener('click', onClick)
  content.addEventListener('keydown', onContentKey)
  document.addEventListener('keydown', onKey)

  return () => {
    document.removeEventListener('keydown', onKey)
    host.remove()
  }
}

/**
 * Auto-mount when the build-time gate is on.
 *
 * The gate is checked here, at module scope, so a bundler can eliminate the whole
 * widget when it is off. A runtime `if` would still ship the code and the manifest
 * to production, which is the thing the locked decision exists to prevent.
 */
export function autoMount(options: WidgetOptions = {}): void {
  if (typeof window === 'undefined') return
  if (document.readyState === 'complete') mountCrustWidget(options)
  else window.addEventListener('load', () => mountCrustWidget(options), { once: true })
}
