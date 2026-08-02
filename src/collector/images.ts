/**
 * Image audit - pure DOM, no network, the highest value-per-line surface in the
 * project (plan §8, Phase 6): every finding maps to a one-line fix.
 */

export interface ImageFinding {
  src: string
  element: string
  kind:
    | 'raw-img'
    | 'lazy-lcp'
    | 'missing-fetchpriority'
    | 'overdownload'
    | 'missing-dimensions'
  message: string
}

export function auditImages(lcpElement: Element | null): ImageFinding[] {
  const findings: ImageFinding[] = []
  const images = Array.from(document.querySelectorAll('img'))
  const dpr = window.devicePixelRatio || 1

  for (const img of images) {
    const src = img.currentSrc || img.src
    if (!src || src.startsWith('data:')) continue
    const descriptor = describe(img)
    const isNextImage = src.includes('/_next/image')
    const isLcp = lcpElement !== null && (img === lcpElement || lcpElement.contains(img))

    if (!isNextImage) {
      findings.push({
        src,
        element: descriptor,
        kind: 'raw-img',
        message: 'raw <img> - next/image would add sizing, format negotiation and lazy loading',
      })
    }

    if (isLcp && img.loading === 'lazy') {
      // The single worst image mistake: the hero waits for the lazy-load
      // observer before it even starts downloading.
      findings.push({
        src,
        element: descriptor,
        kind: 'lazy-lcp',
        message: 'loading="lazy" on the LCP element delays the largest paint',
      })
    }

    if (isLcp && img.getAttribute('fetchpriority') !== 'high') {
      findings.push({
        src,
        element: descriptor,
        kind: 'missing-fetchpriority',
        message: 'LCP image without fetchpriority="high" competes with everything else',
      })
    }

    const rect = img.getBoundingClientRect()
    if (rect.width > 0 && img.naturalWidth > 0) {
      const needed = rect.width * dpr
      // 1.5x slack: srcset granularity makes exact matches unrealistic, and
      // flagging every 10% overshoot teaches people to ignore the audit.
      if (img.naturalWidth > needed * 1.5) {
        const wasted = Math.round(((img.naturalWidth - needed) / img.naturalWidth) * 100)
        findings.push({
          src,
          element: descriptor,
          kind: 'overdownload',
          message: `decoded ${img.naturalWidth}px for a ${Math.round(needed)}px slot - ~${wasted}% wasted; check sizes=`,
        })
      }
    }

    if (!img.getAttribute('width') && !img.getAttribute('height') && img.style.aspectRatio === '') {
      findings.push({
        src,
        element: descriptor,
        kind: 'missing-dimensions',
        message: 'no intrinsic dimensions - the page shifts when it loads',
      })
    }
  }

  return findings
}

function describe(img: HTMLImageElement): string {
  const id = img.id ? `#${img.id}` : ''
  const alt = img.alt ? ` alt="${img.alt.slice(0, 24)}"` : ''
  return `img${id}${alt}`
}
