import { ImageResponse } from 'next/og'

export const alt = 'crust - catch Next.js regressions before they merge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** Dark landing tokens as sRGB - Satori does not evaluate OKLCH. */
const c = {
  bg: '#141414',
  surface: '#1d1d1d',
  fg: '#ededed',
  muted: '#9a9a9a',
  faint: '#6e6e6e',
  border: '#363636',
  red: '#e86a6a',
} as const

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: c.bg,
          color: c.fg,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        {/* Centered shell with hairline side rules - same layout idea as the site. */}
        <div
          style={{
            width: 1080,
            height: '100%',
            margin: '0 auto',
            borderLeft: `1px solid ${c.border}`,
            borderRight: `1px solid ${c.border}`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 72px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 44 }}>
            <svg width="48" height="48" viewBox="0 0 32 32" fill={c.fg}>
              <path d="M26 5v5H6V5h20Z" />
              <path d="M26 12.5V27H13a7 7 0 0 1-7-7V12.5h20Z" />
            </svg>
            <div style={{ fontSize: 34, fontWeight: 550, letterSpacing: '-0.01em' }}>crust</div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 14,
              fontSize: 18,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: c.faint,
              marginBottom: 36,
            }}
          >
            <span>Next 15 & 16</span>
            <span style={{ color: c.border }}>/</span>
            <span>webpack</span>
            <span style={{ color: c.border }}>/</span>
            <span>Turbopack</span>
          </div>

          <div
            style={{
              fontSize: 64,
              fontWeight: 500,
              lineHeight: 1.12,
              letterSpacing: '-0.028em',
              maxWidth: 920,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>Know what became slower</span>
            <span>
              before it{' '}
              <span
                style={{
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textDecorationColor: c.faint,
                  textUnderlineOffset: 10,
                }}
              >
                merges
              </span>
              .
            </span>
          </div>

          <div
            style={{
              marginTop: 36,
              fontSize: 26,
              lineHeight: 1.5,
              color: c.muted,
              maxWidth: 820,
              display: 'flex',
            }}
          >
            Production-build regression blame for Next.js App Router - mode, shell, bytes, and the
            source line that did it.
          </div>

          <div
            style={{
              marginTop: 48,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              border: `1px solid ${c.border}`,
              background: c.surface,
              borderRadius: 10,
              padding: '18px 24px',
              maxWidth: 720,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 22,
            }}
          >
            <span style={{ color: c.red }}>/products/[slug]</span>
            <span style={{ color: c.faint }}>·</span>
            <span style={{ color: c.red }}>static → partial</span>
            <span style={{ color: c.faint }}>·</span>
            <span style={{ color: c.muted }}>shell 100% → 45%</span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
