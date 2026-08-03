import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Metadata } from 'next'
import { GITHUB, SiteFooter, SiteNav } from '../chrome'
import { Inline } from './inline'
import { parseChangelog, type ChangelogEntry, type ChangelogRelease } from './parse'

const NPM = 'https://www.npmjs.com/package/@moumensoliman/crust?activeTab=versions'

export const metadata: Metadata = {
  title: 'Changelog - crust',
  description:
    'Every crust release, what changed in it, and why - including the schema events that decide whether an existing .perf/ history stays comparable.',
  alternates: { canonical: '/changelog' },
  openGraph: {
    title: 'crust changelog',
    description: 'Every release, what changed in it, and why.',
    type: 'article',
    url: '/changelog',
    siteName: 'crust',
  },
}

/**
 * Read at build time, from the repository the site lives in.
 *
 * Failing loudly beats rendering an empty timeline: a changelog page that quietly
 * shows nothing is indistinguishable from a project that has shipped nothing, and
 * the build is the last place able to tell the difference.
 */
function readChangelog(): string {
  const candidates = [join(process.cwd(), '..', 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]
  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      continue
    }
  }
  throw new Error(`CHANGELOG.md not found. Looked in:\n${candidates.map((path) => `  ${path}`).join('\n')}`)
}

const { intro, releases, earlier } = parseChangelog(readChangelog())

/** Achromatic by default; the group name is the only place colour carries meaning. */
const GROUP_COLOR: Record<string, string> = {
  Added: 'text-green',
  Fixed: 'text-amber',
  Changed: 'text-blue',
  Documentation: 'text-muted',
}

const formatDate = (iso: string): string => {
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export default function Changelog() {
  return (
    <div className="mx-auto min-h-screen max-w-shell border-x border-border">
      <SiteNav active="changelog" />

      <header className="border-b border-border px-pad py-[clamp(34px,5vw,60px)]">
        <h1 className="mb-3.5 text-h1 font-medium tracking-[-0.03em] text-balance">Changelog</h1>
        <div className="max-w-[68ch] space-y-2.5">
          {intro.map((paragraph) => (
            <p key={paragraph} className="text-small text-muted text-pretty">
              <Inline text={paragraph} />
            </p>
          ))}
        </div>
      </header>

      <main className="px-pad py-[clamp(30px,4vw,52px)]">
        <ol>
          {releases.map((release, index) => (
            <Release
              key={release.version}
              release={release}
              latest={index === 0}
              last={index === releases.length - 1}
            />
          ))}
        </ol>

        {earlier ? (
          <section className="mt-[clamp(28px,4vw,48px)] rounded-[10px] border border-border bg-surface p-[clamp(18px,2.6vw,26px)]">
            <h2 className="mb-3 text-meta uppercase tracking-[0.09em] text-muted">{earlier.heading}</h2>
            <div className="max-w-[68ch] space-y-2.5">
              {earlier.blocks.map((block, index) =>
                block.kind === 'heading' ? (
                  <h3
                    key={index}
                    className="pt-2 text-body font-[550] tracking-[-0.01em] text-fg"
                  >
                    <Inline text={block.text} />
                  </h3>
                ) : (
                  <p key={index} className="text-small text-muted text-pretty">
                    <Inline text={block.text} />
                  </p>
                ),
              )}
            </div>
            <a className="mt-4 inline-block text-meta text-muted no-underline hover:text-fg" href={NPM}>
              Published versions on npm ↗
            </a>
          </section>
        ) : null}
      </main>

      <SiteFooter />
    </div>
  )
}

function Release({
  release,
  latest,
  last,
}: {
  release: ChangelogRelease
  latest: boolean
  last: boolean
}) {
  return (
    <li className="relative ps-[clamp(22px,3vw,34px)] pb-[clamp(30px,4.5vw,52px)] last:pb-0">
      {/* Drawn per item, and skipped on the oldest release so the line does not run
          past it. `faint/30` because `border` is invisible as a 1px hairline. */}
      {last ? null : <span className="absolute start-[3px] top-[19px] bottom-0 w-px bg-faint/30" aria-hidden />}
      <span
        className={`absolute start-0 top-[7px] size-[9px] rounded-full border ${
          latest ? 'border-fg bg-fg' : 'border-faint bg-bg'
        }`}
        aria-hidden
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="text-h2 font-medium tracking-[-0.02em] tabular-nums">{release.version}</h2>
        {release.date ? (
          <time className="text-meta text-muted tabular-nums" dateTime={release.date}>
            {formatDate(release.date)}
          </time>
        ) : null}
        {latest ? (
          <span className="rounded-full border border-border px-2 py-[1px] text-micro uppercase tracking-[0.09em] text-muted">
            Latest
          </span>
        ) : null}
      </div>

      <div className="mt-[18px] space-y-[22px]">
        {release.groups
          .filter((group) => group.entries.length > 0)
          .map((group) => (
            <section key={group.name}>
              <h3
                className={`mb-2.5 text-micro uppercase tracking-[0.09em] ${GROUP_COLOR[group.name] ?? 'text-muted'}`}
              >
                {group.name}
              </h3>
              <ul className="space-y-3.5">
                {group.entries.map((entry, index) => (
                  <Entry key={index} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
      </div>
    </li>
  )
}

/**
 * The claim in full colour, the reasoning behind it in muted. Both are always
 * present - this changelog explains itself at length on purpose, and hiding the
 * reasoning behind a toggle would bury the only part that answers "why".
 */
function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="max-w-[74ch] text-small leading-[1.65]">
      <span className="text-fg">
        <Inline text={entry.lead} />
      </span>
      {entry.rest ? (
        <span className="text-muted">
          {' '}
          <Inline text={entry.rest} />
        </span>
      ) : null}
      {entry.children.length > 0 ? (
        <ul className="mt-2 space-y-2 border-s border-border ps-3.5">
          {entry.children.map((child, index) => (
            <li key={index} className="text-muted">
              <Inline text={child} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
