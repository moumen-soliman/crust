import { Mark } from './mark'

export const DOCS = 'https://docs.crust.moumen.dev'
export const GITHUB = 'https://github.com/moumen-soliman/crust'

const navLink =
  'text-micro uppercase tracking-[0.09em] no-underline transition-colors duration-[120ms] hover:text-fg'

/**
 * Shared page chrome. Extracted when the changelog became a second page: two
 * copies of a nav is two places to add the next link to, and one of them is
 * always the one that gets forgotten.
 */
export function SiteNav({ active }: { active?: 'changelog' } = {}) {
  return (
    <nav className="sticky top-0 z-20 flex h-[54px] items-center gap-5 border-b border-border bg-bg/84 px-pad backdrop-blur-[12px] backdrop-saturate-[180%]">
      <a className="inline-flex items-center gap-2 text-body font-[550] tracking-[-0.01em] no-underline" href="/">
        <Mark size={17} />
        crust
      </a>
      <div className="mx-auto flex gap-[26px] max-[720px]:hidden">
        <a className={`${navLink} text-muted`} href={`${DOCS}/docs/quickstart`}>
          Quickstart
        </a>
        <a className={`${navLink} text-muted`} href={`${DOCS}/docs/concepts/regressions`}>
          How it thinks
        </a>
        <a className={`${navLink} text-muted`} href={`${DOCS}/docs/reference/cli`}>
          CLI
        </a>
        <a className={`${navLink} ${active === 'changelog' ? 'text-fg' : 'text-muted'}`} href="/changelog">
          Changelog
        </a>
      </div>
      <a className="inline-flex items-center gap-[7px] text-meta text-muted no-underline hover:text-fg" href={GITHUB}>
        GitHub
      </a>
    </nav>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border py-[22px]">
      <div className="flex flex-wrap items-center gap-4 px-pad text-meta text-muted">
        <Mark size={14} />
        <a className="no-underline hover:text-fg" href={DOCS}>
          Docs
        </a>
        <span className="text-border">/</span>
        <a className="no-underline hover:text-fg" href="/changelog">
          Changelog
        </a>
        <span className="text-border">/</span>
        <a className="no-underline hover:text-fg" href={GITHUB}>
          GitHub
        </a>
        <span className="text-border">/</span>
        {/* `master` is the branch this repository has. The old `main` link 404'd. */}
        <a className="no-underline hover:text-fg" href={`${GITHUB}/blob/master/LICENSE`}>
          MIT
        </a>
        <span className="ms-auto max-[520px]:ms-0 max-[520px]:w-full">
          Next.js 15 &amp; 16 · webpack + Turbopack · Node 20+
        </span>
      </div>
    </footer>
  )
}
