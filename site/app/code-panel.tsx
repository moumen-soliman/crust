'use client'

import { useId, useState, type ReactNode } from 'react'

export interface CodeTab {
  name: string
  lines: ReactNode[]
}

/**
 * Tabbed code panel. Every tab's content is rendered into the markup and hidden
 * with `hidden`, so the panel is complete in the prerendered shell and switching
 * costs no request — the page it advertises is the page it should model.
 */
export function CodePanel({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(0)
  const id = useId()

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
      <div className="flex border-b border-border" role="tablist" aria-label="Examples">
        {tabs.map((tab, i) => (
          <button
            key={tab.name}
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
                  ? (active + 1) % tabs.length
                  : (active - 1 + tabs.length) % tabs.length
              setActive(next)
              document.getElementById(`${id}-tab-${next}`)?.focus()
            }}
          >
            {tab.name}
          </button>
        ))}
      </div>

      {tabs.map((tab, i) => (
        <pre
          key={tab.name}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
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
      ))}
    </div>
  )
}
