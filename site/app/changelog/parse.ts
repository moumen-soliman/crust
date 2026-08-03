/**
 * CHANGELOG.md is the source. This page renders it.
 *
 * The alternative - a hand-written timeline - is a second copy of the release
 * history that drifts from the first, and for a tool whose whole subject is
 * "what changed since the last build" that would be an unusually bad look.
 */

export interface ChangelogEntry {
  /** Leading sentence, carrying the claim. */
  lead: string
  /** Everything after it - the reasoning. Empty when the entry is one sentence. */
  rest: string
  /** Nested `  - ` bullets, kept as written. */
  children: string[]
}

export interface ChangelogGroup {
  /** `Added`, `Fixed`, `Changed`, `Documentation`. */
  name: string
  entries: ChangelogEntry[]
}

export interface ChangelogRelease {
  /** `0.1.6`, or `Unreleased`. */
  version: string
  /** ISO date from the heading, when it carries one. */
  date: string | null
  groups: ChangelogGroup[]
}

export interface Changelog {
  /** Prose above the first release heading. */
  intro: string[]
  /** Newest first, in file order. Releases with no entries are dropped. */
  releases: ChangelogRelease[]
  /** The trailing prose section, for versions older than the changelog itself. */
  earlier: { heading: string; blocks: EarlierBlock[] } | null
}

export type EarlierBlock = { kind: 'heading'; text: string } | { kind: 'paragraph'; text: string }

const RELEASE = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/
const SECTION = /^## (.+?)\s*$/
const GROUP = /^### (.+?)\s*$/
const BULLET = /^- (.+)$/
const CHILD = /^ {2,3}- (.+)$/
/** A wrapped continuation of the bullet above, not a new one. */
const CONTINUATION = /^ {2,}(?!- )(\S.*)$/

export function parseChangelog(markdown: string): Changelog {
  const intro: string[] = []
  const releases: ChangelogRelease[] = []
  let earlier: Changelog['earlier'] = null

  let release: ChangelogRelease | null = null
  let group: ChangelogGroup | null = null
  let entry: ChangelogEntry | null = null
  /** Set once the trailing prose section starts; releases stop being collected. */
  let inEarlier = false
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (!text) return
    if (inEarlier && earlier) earlier.blocks.push({ kind: 'paragraph', text })
    else if (!release) intro.push(text)
  }

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '')

    // The document title. The page has its own heading, so this would otherwise
    // read as the first sentence of the intro.
    if (/^# /.test(line)) continue

    const releaseHeading = RELEASE.exec(line)
    if (releaseHeading) {
      flushParagraph()
      entry = null
      group = null
      release = { version: releaseHeading[1]!, date: releaseHeading[2] ?? null, groups: [] }
      releases.push(release)
      continue
    }

    const section = SECTION.exec(line)
    if (section && !line.startsWith('## [')) {
      flushParagraph()
      entry = null
      group = null
      release = null
      inEarlier = true
      earlier = { heading: section[1]!, blocks: [] }
      continue
    }

    const heading = GROUP.exec(line)
    if (heading) {
      flushParagraph()
      entry = null
      if (inEarlier && earlier) {
        earlier.blocks.push({ kind: 'heading', text: heading[1]! })
        continue
      }
      group = { name: heading[1]!, entries: [] }
      release?.groups.push(group)
      continue
    }

    const child = CHILD.exec(line)
    if (child && entry) {
      entry.children.push(child[1]!)
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet && group) {
      entry = { lead: bullet[1]!, rest: '', children: [] }
      group.entries.push(entry)
      continue
    }

    const continuation = CONTINUATION.exec(line)
    if (continuation && entry) {
      // Wrapped text belongs to whichever bullet was last opened.
      if (entry.children.length > 0) entry.children[entry.children.length - 1] += ` ${continuation[1]!}`
      else entry.lead += ` ${continuation[1]!}`
      continue
    }

    if (line === '') {
      flushParagraph()
      entry = null
      continue
    }

    if (!release || inEarlier) paragraph.push(line)
  }
  flushParagraph()

  for (const item of releases) {
    for (const groupItem of item.groups) {
      groupItem.entries = groupItem.entries.map(splitLead)
    }
  }

  return {
    intro,
    // An empty `## [Unreleased]` is a placeholder for the next release, not a release.
    releases: releases.filter((item) => item.groups.some((groupItem) => groupItem.entries.length > 0)),
    earlier,
  }
}

/**
 * Split the claim from the reasoning, so a reader can scan the claims and stop at
 * the one they care about.
 *
 * Bounded on both sides: a fragment too short to be a claim, or a first sentence
 * long enough to be the whole entry, is left unsplit rather than cut at a
 * misdetected boundary. `0.1.4.` and `e.g.` are exactly the sentence ends that are
 * not sentence ends, hence the requirement for a following capital.
 */
function splitLead(entry: ChangelogEntry): ChangelogEntry {
  const match = /^(.{40,220}?[.:])\s+(?=[A-Z`])/.exec(entry.lead)
  if (!match) return entry
  return { ...entry, lead: match[1]!, rest: entry.lead.slice(match[0].length).trim() }
}
