import { Fragment } from 'react'
import { Mark } from './mark'

export const DOCS = 'https://docs.crust.moumen.dev'
export const GITHUB = 'https://github.com/moumen-soliman/crust'

const navLink =
  'text-micro uppercase tracking-[0.09em] no-underline transition-colors duration-[120ms] hover:text-fg'

type Page = 'changelog'

const NAV: { label: string; href: string; page?: Page }[] = [
  { label: 'Quickstart', href: `${DOCS}/docs/quickstart` },
  { label: 'How it thinks', href: `${DOCS}/docs/concepts/regressions` },
  { label: 'CLI', href: `${DOCS}/docs/reference/cli` },
  { label: 'Changelog', href: '/changelog', page: 'changelog' },
]

/**
 * Shared page chrome. Two copies of a nav is two places to add the next link to,
 * and one of them is always the one that gets forgotten.
 */
export function SiteNav({ active }: { active?: Page }) {
  return (
    <nav className="sticky top-0 z-20 flex h-[54px] items-center gap-5 border-b border-border bg-bg/84 px-pad backdrop-blur-[12px] backdrop-saturate-[180%]">
      <a className="inline-flex items-center gap-2 text-body font-[550] tracking-[-0.01em] no-underline" href="/">
        <Mark size={17} />
        crust
      </a>
      <div className="mx-auto flex gap-[26px] max-[720px]:hidden">
        {NAV.map((link) => (
          <a
            key={link.href}
            className={`${navLink} ${link.page && link.page === active ? 'text-fg' : 'text-muted'}`}
            href={link.href}
          >
            {link.label}
          </a>
        ))}
      </div>
      <a className="inline-flex items-center gap-[7px] text-meta text-muted no-underline hover:text-fg" href={GITHUB}>
        GitHub
      </a>
    </nav>
  )
}

// `blob/master`, not `blob/main` - this repository has no `main` branch.
const FOOTER: { label: string; href: string }[] = [
  { label: 'Docs', href: DOCS },
  { label: 'Changelog', href: '/changelog' },
  { label: 'GitHub', href: GITHUB },
  { label: 'MIT', href: `${GITHUB}/blob/master/LICENSE` },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border py-[22px]">
      <div className="flex flex-wrap items-center gap-4 px-pad text-meta text-muted">
        <Mark size={14} />
        {FOOTER.map((link, index) => (
          <Fragment key={link.href}>
            {index > 0 ? <span className="text-border">/</span> : null}
            <a className="no-underline hover:text-fg" href={link.href}>
              {link.label}
            </a>
          </Fragment>
        ))}
        <span className="ms-auto max-[520px]:ms-0 max-[520px]:w-full">
          Next.js 15 &amp; 16 · webpack + Turbopack · Node 20+
        </span>
      </div>
    </footer>
  )
}
