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
    font: 500 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    letter-spacing: -0.005em;
    /* 44px touch target on a 32px-tall pill: the hit area is extended rather
       than the button made chunky. */
    min-height: 44px; padding: 0 14px;
    display: inline-flex; align-items: center; gap: 7px;
    cursor: pointer; border: 0; border-radius: 999px;
    background: oklch(0.205 0 0); color: oklch(1 0 0);
    /* The launcher genuinely floats over an unknown page, so it earns a shadow;
       everything inside the panel is separated by hairlines instead. */
    box-shadow: 0 1px 2px oklch(0 0 0 / 0.16), 0 8px 20px oklch(0 0 0 / 0.16);
    transition-property: scale, opacity;
    transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  .launch:hover { opacity: 0.88; }
  .launch:active { scale: 0.96; }
  .launch:focus-visible { outline: 2px solid oklch(0.58 0.22 254); outline-offset: 2px; }
  .launch svg { width: 12px; height: 12px; flex: none; }
  @media (prefers-color-scheme: dark) {
    .launch { background: oklch(1 0 0); color: oklch(0 0 0); }
    .launch:focus-visible { outline-color: oklch(0.65 0.19 254); }
  }

  .panel {
    display: none; position: fixed; ${vertical}: 68px; ${horizontal}: 16px;
    width: min(820px, calc(100vw - 32px)); max-height: min(74vh, 820px); overflow: auto;
    /* Concentric: a 12px radius with 20px padding leaves nothing flush to the
       corner, which is why no surface inside carries its own rounded background. */
    border-radius: 12px; padding: 20px 24px 24px;
    background: oklch(1 0 0);
    border: 1px solid oklch(0.922 0 0);
    box-shadow: 0 2px 4px oklch(0 0 0 / 0.04), 0 16px 48px oklch(0 0 0 / 0.14);
    overscroll-behavior: contain;
  }
  @media (prefers-color-scheme: dark) {
    .panel { background: oklch(0 0 0); border-color: oklch(0.269 0 0);
      box-shadow: 0 2px 4px oklch(0 0 0 / 0.5), 0 16px 48px oklch(0 0 0 / 0.6); }
  }
  .panel.open { display: block; animation: panel-in 220ms cubic-bezier(0.2, 0, 0, 1); }
  @keyframes panel-in { from { opacity: 0; translate: 0 6px; } to { opacity: 1; translate: 0 0; } }

  .close {
    position: sticky; top: 0; float: inline-end; z-index: 1;
    width: 40px; height: 40px; margin: -8px -12px 0 0;
    display: grid; place-items: center;
    cursor: pointer; border: 0; border-radius: 6px; background: none;
    font-size: 15px; line-height: 1; color: oklch(0.556 0 0);
    transition-property: scale, color; transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .close:hover { color: oklch(0.205 0 0); }
  .close:active { scale: 0.96; }
  .close:focus-visible { outline: 2px solid oklch(0.58 0.22 254); outline-offset: -2px; }
  @media (prefers-color-scheme: dark) { .close:hover { color: oklch(0.94 0 0); } }

  @media (prefers-reduced-motion: reduce) {
    .launch, .close { transition-duration: 0.01ms; }
    .launch:active, .close:active { scale: 1; }
    .panel.open { animation-duration: 0.01ms; }
  }

  ${renderReportStyles()}
  ${renderLiveStyles()}
</style>
<button class="launch" type="button" part="launcher" aria-expanded="false"><svg viewBox="0 0 32 32" aria-hidden="true" fill="currentColor"><path d="M26 5v5H6V5h20Z"/><path d="M26 12.5V27H13a7 7 0 0 1-7-7V12.5h20Z"/></svg>crust</button>
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
