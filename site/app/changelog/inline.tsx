import type { ReactNode } from 'react'
import { GITHUB } from '../chrome'

/**
 * Links in the changelog are written for a reader on GitHub, so a bare
 * `COMPATIBILITY.md` means "the file next to this one". On the site that resolves
 * against the domain and 404s, so repository-relative targets are sent back to the
 * repository.
 */
function resolveHref(href: string): string {
  if (/^(?:[a-z]+:|\/\/|[#/])/i.test(href)) return href
  return `${GITHUB}/blob/master/${href}`
}

/**
 * The four inline forms the changelog uses: `code`, **bold**, *italic*, links.
 * Nodes rather than injected HTML, so entries style themselves with the site's
 * own tokens instead of needing a stylesheet for raw markup.
 */
const PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/

// Split keeps the delimiters, so a token either matched PATTERN or is plain text;
// the openers below are enough to tell which, and each is guaranteed non-empty.
export function Inline({ text }: { text: string }): ReactNode {
  return text.split(PATTERN).map((token, key) => {
    if (token.startsWith('`')) {
      return (
        <code key={key} className="rounded-[4px] bg-raised px-[4px] py-[1px] text-[0.92em] text-fg">
          {token.slice(1, -1)}
        </code>
      )
    }

    if (token.startsWith('**')) {
      return (
        <strong key={key} className="font-[550] text-fg">
          {token.slice(2, -2)}
        </strong>
      )
    }

    if (token.startsWith('*')) {
      return (
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }

    const link = LINK.exec(token)
    if (link) {
      return (
        <a
          key={key}
          className="underline decoration-border decoration-1 underline-offset-2 transition-colors duration-[120ms] hover:decoration-fg"
          href={resolveHref(link[2]!)}
        >
          {link[1]}
        </a>
      )
    }

    return token
  })
}
