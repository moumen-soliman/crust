'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface CodeTab {
  name: string
  lines: ReactNode[]
}

/**
 * Safari / iOS refuse autoplay unless the element is clearly muted + inline.
 * React often omits the `muted` *attribute* from the DOM (only sets the
 * property), which Safari treats as unmuted — so autoplay is denied. Force
 * both attribute and property, plus the legacy webkit playsinline flag.
 */
function armMutedInline(el: HTMLVideoElement) {
  el.defaultMuted = true
  el.muted = true
  el.setAttribute('muted', '')
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
}

function disarmMute(el: HTMLVideoElement) {
  el.defaultMuted = false
  el.muted = false
  el.removeAttribute('muted')
}

async function tryPlay(el: HTMLVideoElement) {
  try {
    await el.play()
  } catch {
    // Low Power Mode / data saver / policy — poster stays; Sound on is the out.
  }
}

/**
 * Hero media: product video first, then the same tabbed CLI examples.
 * Muted autoplay in the watch tab; hover reveals unmute. Switching away
 * pauses so a scrolled-off clip never keeps talking.
 */
export function HeroPanel({
  video,
  tabs,
}: {
  video: { src: string; poster: string; name?: string }
  tabs: CodeTab[]
}) {
  const [active, setActive] = useState(0)
  const [muted, setMuted] = useState(true)
  const [reduceMotion, setReduceMotion] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const id = useId()
  const videoName = video.name ?? 'watch'
  const labels = [videoName, ...tabs.map((tab) => tab.name)]

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduceMotion(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    el.loop = muted && !reduceMotion

    if (muted) armMutedInline(el)
    else disarmMute(el)

    if (active !== 0 || reduceMotion) {
      el.pause()
      return
    }

    // Imperative play: Safari ignores a late/conditional autoPlay flip.
    void tryPlay(el)

    const retry = () => {
      if (el.paused && muted) void tryPlay(el)
    }
    el.addEventListener('loadeddata', retry)
    el.addEventListener('canplay', retry)
    return () => {
      el.removeEventListener('loadeddata', retry)
      el.removeEventListener('canplay', retry)
    }
  }, [active, muted, reduceMotion])

  function bindVideo(el: HTMLVideoElement | null) {
    videoRef.current = el
    // First paint always starts muted + inline so Safari can autoplay.
    if (el) armMutedInline(el)
  }

  function toggleMute() {
    const el = videoRef.current
    const next = !muted
    setMuted(next)
    if (!el) return
    if (next) {
      armMutedInline(el)
    } else {
      // Unmute is a user gesture — Safari allows sound + resume here.
      disarmMute(el)
      void tryPlay(el)
    }
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
      <div className="flex border-b border-border" role="tablist" aria-label="Product preview">
        {labels.map((label, i) => (
          <button
            key={label}
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            className={`min-h-10 appearance-none border-0 border-r border-border bg-transparent px-[15px] py-[11px] font-mono text-meta font-medium leading-none transition-[color,background-color] duration-[120ms] cursor-pointer focus-visible:outline-2 focus-visible:outline-blue focus-visible:-outline-offset-2 ${
              i === active ? 'bg-raised text-fg' : 'text-faint hover:text-muted'
            }`}
            onClick={() => setActive(i)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              event.preventDefault()
              const next =
                event.key === 'ArrowRight'
                  ? (active + 1) % labels.length
                  : (active - 1 + labels.length) % labels.length
              setActive(next)
              document.getElementById(`${id}-tab-${next}`)?.focus()
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel-0`}
        aria-labelledby={`${id}-tab-0`}
        hidden={active !== 0}
        className="group relative bg-bg"
      >
        <video
          ref={bindVideo}
          className="block aspect-video w-full bg-bg object-cover"
          // Declarative triad for engines that honor it. Safari still needs
          // armMutedInline (DOM attribute) + imperative play() above.
          autoPlay
          muted={muted}
          loop={muted && !reduceMotion}
          playsInline
          preload="auto"
          poster={video.poster}
          controls={reduceMotion || !muted}
          disableRemotePlayback
          aria-label="crust product walkthrough"
        >
          <source src={video.src} type="video/mp4" />
        </video>

        {!reduceMotion ? (
          <button
            type="button"
            onClick={toggleMute}
            className={`absolute bottom-3 left-3 z-10 inline-flex min-h-8 items-center rounded-[7px] border border-border bg-surface/92 px-2.5 font-mono text-meta font-medium text-fg backdrop-blur-sm transition-[opacity,background-color] duration-[160ms] ease-crust cursor-pointer hover:bg-raised focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 motion-reduce:transition-none ${
              muted
                ? // Touch keeps the chip visible; hover devices reveal it on hover/focus.
                  'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100'
                : 'opacity-100'
            }`}
            aria-pressed={!muted}
            aria-label={muted ? 'Turn sound on' : 'Mute'}
          >
            {muted ? 'Sound on' : 'Mute'}
          </button>
        ) : null}
      </div>

      {tabs.map((tab, i) => {
        const panel = i + 1
        return (
          <pre
            key={tab.name}
            role="tabpanel"
            id={`${id}-panel-${panel}`}
            aria-labelledby={`${id}-tab-${panel}`}
            hidden={active !== panel}
            className="m-0 overflow-x-auto py-[16px] pr-1 pl-0 text-meta leading-[1.7]"
          >
            <code>
              {tab.lines.map((line, n) => (
                <span key={n}>
                  <span className="inline-block w-10 pr-[14px] text-right text-faint select-none">
                    {n + 1}
                  </span>
                  {line}
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        )
      })}
    </div>
  )
}
