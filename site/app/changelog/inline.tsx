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
 * The four inline forms the changelog actually uses: `code`, **bold**, *italic*,
 * and [links](url).
 *
 * Nodes are built rather than HTML injected. A changelog is not user input, so
 * this is not a sanitisation story - it is that `dangerouslySetInnerHTML` would
 * make every future entry a potential layout break, and the styling here has to
 * match tokens the rest of the site uses anyway.
 */
const PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

export function Inline({ text }: { text: string }): ReactNode {
  return text.split(PATTERN).map((token, index) => {
    const key = `${index}-${token.slice(0, 12)}`

    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <code key={key} className="rounded-[4px] bg-raised px-[4px] py-[1px] text-[0.92em] text-fg">
          {token.slice(1, -1)}
        </code>
      )
    }

    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return (
        <strong key={key} className="font-[550] text-fg">
          {token.slice(2, -2)}
        </strong>
      )
    }

    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return (
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
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
