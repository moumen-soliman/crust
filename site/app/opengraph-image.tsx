import { ImageResponse } from 'next/og'

export const alt =
  'crust - the production-build diff for Next.js that helps you decide what can ship'
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
  green: '#5ecf8f',
} as const

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'

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
            padding: '0 64px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 34 }}>
            <svg width="42" height="42" viewBox="0 0 32 32" fill={c.fg}>
              <path d="M26 5v5H6V5h20Z" />
              <path d="M26 12.5V27H13a7 7 0 0 1-7-7V12.5h20Z" />
            </svg>
            <div style={{ fontSize: 31, fontWeight: 550, letterSpacing: '-0.01em' }}>crust</div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 12,
              fontSize: 17,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: c.faint,
              marginBottom: 28,
            }}
          >
            <span>Next 15 & 16</span>
            <span style={{ color: c.border }}>/</span>
            <span>webpack</span>
            <span style={{ color: c.border }}>/</span>
            <span>Turbopack</span>
          </div>

          {/* Headline follows the README lead: crust supplies the evidence, the merge call
              stays with the reader. Satori collapses `{' '}` between spans, so each word
              group is a flex child with an explicit gap. */}
          <div
            style={{
              fontSize: 54,
              fontWeight: 500,
              lineHeight: 1.12,
              letterSpacing: '-0.028em',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>The production-build diff that</span>
            <div style={{ display: 'flex', gap: 14 }}>
              <span>helps you</span>
              <span
                style={{
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textDecorationColor: c.faint,
                  textUnderlineOffset: 9,
                }}
              >
                decide what can ship
              </span>
            </div>
          </div>

          <div
            style={{
              marginTop: 26,
              fontSize: 22,
              lineHeight: 1.5,
              color: c.muted,
              maxWidth: 900,
              display: 'flex',
            }}
          >
            Compare two Next.js App Router builds. Every regression is grouped by cause and traced
            to source, so the merge call rests on evidence.
          </div>

          {/* Decision-first strip - the shape of the terminal output, not a route inventory. */}
          <div
            style={{
              marginTop: 34,
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${c.border}`,
              background: c.surface,
              borderRadius: 10,
              maxWidth: 860,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                borderBottom: `1px solid ${c.border}`,
                padding: '11px 20px',
                fontFamily: mono,
                fontSize: 16,
                color: c.faint,
              }}
            >
              <span>10 changed</span>
              <span style={{ color: c.border }}>·</span>
              <span style={{ color: c.red }}>9 regressions</span>
              <span style={{ color: c.border }}>·</span>
              <span style={{ color: c.green }}>1 improvement</span>
              <span style={{ color: c.border }}>·</span>
              <span>attribution 94%</span>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: '16px 20px 18px',
                fontFamily: mono,
                fontSize: 20,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span
                  style={{
                    color: c.red,
                    border: `1px solid ${c.red}`,
                    borderRadius: 5,
                    padding: '2px 9px',
                    fontSize: 17,
                    letterSpacing: '0.06em',
                  }}
                >
                  DECISION BLOCK
                </span>
                <span style={{ color: c.fg }}>/products/[slug] is no longer static</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: c.muted }}>
                <span>shell 100% → 45%</span>
                <span style={{ color: c.border }}>·</span>
                <span>+48.2 kB</span>
                <span style={{ color: c.border }}>·</span>
                <span style={{ color: c.faint }}>lib/http.ts:3 in &lt;ProductGallery&gt;</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
