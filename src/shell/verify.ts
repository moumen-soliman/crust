import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ActualShell } from '../store/snapshot.ts'
import { toPosix } from '../core/workspace.ts'

/**
 * Layer 2 of the shell engine: read the shell the build actually produced.
 *
 * Deliberately plain HTML parsing. `postponedState` is opaque by contract — the
 * docs are explicit that reading or altering it produces incorrect output — and
 * it turns out never to be needed: the prerendered HTML already contains each
 * fallback sitting exactly where its hole is, with boundary ids assigned in
 * document order (docs/phase-0-findings.md §3).
 *
 * React's shell markers:
 *   <!--$?-->  a pending boundary; its fallback follows, then <template id="B:0">
 *   <!--$-->   a resolved boundary
 *   <!--/$-->  boundary close
 */
export async function readActualShell(distDir: string, pattern: string): Promise<ActualShell | null> {
  const htmlPath = await findShellHtml(distDir, pattern)
  if (!htmlPath) return null

  const html = await readFile(join(distDir, htmlPath), 'utf8')
  const bytes = Buffer.byteLength(html)

  const holes = countOccurrences(html, '<!--$?-->')
  const boundaryIds = [...html.matchAll(/<template id="(B:\d+)"/g)].map((m) => m[1]!)

  return {
    htmlPath,
    bytes,
    holes,
    boundaryIds,
    shellRatio: computeShellRatio(html),
  }
}

/**
 * A route with `generateStaticParams` emits both `products/[slug].html` — the
 * unparameterized fallback, which is **zero bytes** — and `products/alpha.html`,
 * the real shell. Diffing against the empty one reports that the entire shell
 * vanished on every build, so a parameterized shell is preferred whenever one
 * exists (docs/phase-0-findings.md §3).
 */
async function findShellHtml(distDir: string, pattern: string): Promise<string | null> {
  const appDir = join(distDir, 'server', 'app')
  const direct = pattern === '/' ? 'index.html' : `${pattern.replace(/^\//, '')}.html`

  const candidates: string[] = []
  if (!pattern.includes('[')) {
    candidates.push(direct)
  } else {
    // Substitute concrete params: look for siblings of the bracketed segment.
    const dir = join(appDir, dirname_(pattern.replace(/^\//, '')))
    let entries: string[] = []
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => e.name)
    } catch {
      entries = []
    }
    // Prefer any concrete param over the bracketed fallback.
    const bracketed = `${basename_(pattern)}.html`
    for (const name of entries.sort()) {
      if (name === bracketed) continue
      candidates.push(toPosix(join(relative(appDir, dir), name)))
    }
    candidates.push(toPosix(join(relative(appDir, dir), bracketed)))
  }

  for (const candidate of candidates) {
    const full = join(appDir, candidate)
    try {
      const info = await stat(full)
      if (info.size > 0) return toPosix(join('server', 'app', candidate))
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * How much of the rendered route made it into the shell.
 *
 * Measured as the share of body text that is not inside a pending boundary, which
 * tracks what a user sees before hydration far better than raw byte counts do —
 * inline scripts and the flight payload dwarf the markup and would swamp any
 * byte-based figure.
 */
function computeShellRatio(html: string): number {
  const body = stripScripts(html)
  const total = visibleTextLength(body)
  if (total === 0) return 0

  let postponed = 0
  const openTag = '<!--$?-->'
  const closeTag = '<!--/$-->'
  let cursor = 0
  for (;;) {
    const start = body.indexOf(openTag, cursor)
    if (start === -1) break
    const end = body.indexOf(closeTag, start)
    if (end === -1) break
    postponed += visibleTextLength(body.slice(start, end))
    cursor = end + closeTag.length
  }

  return Math.max(0, Math.min(1, (total - postponed) / total))
}

function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<head>[\s\S]*?<\/head>/, '')
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim().length
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

const dirname_ = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

const basename_ = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}
