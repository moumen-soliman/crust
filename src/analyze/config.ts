import type { BuildConfig, RouteSnapshot, Snapshot } from '../store/snapshot.ts'

/**
 * Configuration changes, kept apart from application-source regressions
 * (roadmap §7).
 *
 * Turning on Cache Components moves rendering on every route in the app. So
 * does changing bundler, or a Next major. Reporting those as twenty regressions
 * blames whoever flipped the flag for twenty defects they did not write, and -
 * worse - buries the one real regression in the same PR among them.
 *
 * The rule is the same one the diff already applies to bundlers: say what
 * changed about the build, say what it explains, and only then talk about code.
 */

/** `experimental.*` keys that change what the build emits, and are worth diffing. */
const MATERIAL_EXPERIMENTAL = [
  'ppr',
  'dynamicIO',
  'reactCompiler',
  'serverActions',
  'optimizePackageImports',
  'turbo',
  'useCache',
  'inlineCss',
  'clientSegmentCache',
]

export function readBuildConfig(input: {
  resolved: Record<string, unknown> | null
  sourceMaps: boolean
}): BuildConfig {
  const resolved = input.resolved ?? {}
  const experimental = (resolved['experimental'] ?? {}) as Record<string, unknown>

  const material: Record<string, string | number | boolean> = {}
  for (const key of MATERIAL_EXPERIMENTAL) {
    const value = experimental[key]
    if (value === undefined || value === null) continue
    // Objects are recorded as present rather than serialised. Their contents
    // move between minors for reasons nobody's PR caused, and a diff that fires
    // on that is the noise this file exists to remove.
    material[key] = typeof value === 'object' ? true : (value as string | number | boolean)
  }

  return {
    cacheComponents: resolved['cacheComponents'] === true,
    experimental: material,
    sourceMaps: input.sourceMaps,
    partialPrefetching: readPartialPrefetching(resolved),
    instantValidation: readInstantValidation(experimental),
  }
}

/**
 * `partialPrefetching` is a top-level key, beside `cacheComponents` - not an
 * `experimental.*` one. Verified against next@16.3.0
 * (`dist/server/config-shared.d.ts`), and read back out of a real build's
 * `required-server-files.json`, where it appears at the root of `.config`.
 *
 * Absent is recorded as `false` rather than left unset: Next documents omitted
 * and `false` as the same behaviour, so a build without the key genuinely is a
 * build that opted out. That keeps `undefined` meaning one thing only - a record
 * written before crust read this field.
 */
function readPartialPrefetching(resolved: Record<string, unknown>): boolean | 'unstable_eager' {
  const value = resolved['partialPrefetching']
  if (value === 'unstable_eager') return 'unstable_eager'
  return value === true
}

/**
 * Next resolves the default into the config rather than leaving it implicit - a
 * 16.3 build with no `instantInsights` block still records
 * `{validationLevel: 'warning'}`. So the raw value is the whole story, and `null`
 * is reserved for a Next that has no such key at all.
 */
function readInstantValidation(experimental: Record<string, unknown>): string | null {
  const insights = experimental['instantInsights']
  if (!insights || typeof insights !== 'object') return null
  const level = (insights as Record<string, unknown>)['validationLevel']
  return typeof level === 'string' ? level : null
}

export interface ConfigChange {
  /** `cacheComponents`, `bundler`, `/products/[slug] · revalidate`. */
  key: string
  /**
   * The route this governs, for segment config; absent for build-level settings.
   * Carried rather than encoded in `key`, so readers do not have to agree on how
   * to split the string back apart.
   */
  route?: string
  /** The segment key alone - `revalidate`, `dynamic` - when `route` is set. */
  setting?: string
  before: string
  after: string
  /** One line, ready to print. The diff surfaces these verbatim. */
  summary: string
  /**
   * What this change is expected to move on its own. Printed instead of - not
   * alongside - the per-route regressions it accounts for.
   */
  explains: string
  /** True when the change makes the two builds unsafe to compare at all. */
  incomparable: boolean
}

/**
 * Everything about the build, rather than the code, that moved between two
 * snapshots.
 */
export function compareConfig(base: Snapshot, head: Snapshot): ConfigChange[] {
  const changes: ConfigChange[] = []
  const before = base.config
  const after = head.config

  if (base.bundler !== head.bundler) {
    changes.push({
      key: 'bundler',
      before: base.bundler,
      after: head.bundler,
      summary: `bundler changed: ${base.bundler} -> ${head.bundler}`,
      explains: 'chunk boundaries and therefore every route size; module attribution may shift wholesale',
      incomparable: true,
    })
  }

  if (major(base.nextVersion) !== major(head.nextVersion)) {
    changes.push({
      key: 'next',
      before: base.nextVersion,
      after: head.nextVersion,
      explains: 'framework runtime size and rendering defaults',
      summary: `Next major changed: ${base.nextVersion} -> ${head.nextVersion}`,
      incomparable: true,
    })
  } else if (base.nextVersion !== head.nextVersion) {
    changes.push({
      key: 'next',
      before: base.nextVersion,
      after: head.nextVersion,
      explains: 'framework runtime size, within one major',
      summary: `Next changed: ${base.nextVersion} -> ${head.nextVersion}`,
      incomparable: false,
    })
  }

  if (before && after && before.cacheComponents !== after.cacheComponents) {
    changes.push({
      key: 'cacheComponents',
      before: String(before.cacheComponents),
      after: String(after.cacheComponents),
      summary: `Cache Components turned ${after.cacheComponents ? 'on' : 'off'}`,
      // The rule set inverts. Every route's mode can move without a line of
      // application code changing, which is exactly the case that must not be
      // reported as an app regression.
      explains: after.cacheComponents
        ? 'rendering is now opt-in: routes without `use cache` become partially static or dynamic'
        : 'rendering is static by default again: routes that were partially static may report as static',
      incomparable: true,
    })
  }

  // Both sides must have recorded it. `undefined -> false` on a baseline that
  // predates the field is the same fabricated change the guard below exists for,
  // and it would land on every route in the app at once.
  if (
    before?.partialPrefetching !== undefined &&
    after?.partialPrefetching !== undefined &&
    before.partialPrefetching !== after.partialPrefetching
  ) {
    changes.push({
      key: 'partialPrefetching',
      before: String(before.partialPrefetching),
      after: String(after.partialPrefetching),
      summary: `partialPrefetching changed: ${String(before.partialPrefetching)} -> ${String(after.partialPrefetching)}`,
      explains: partialPrefetchingExplains(after.partialPrefetching),
      // Comparable, and that is measured rather than assumed. Two 16.3.0 builds of
      // one app differing only in this flag emit the same artifact tree file for
      // file, a byte-identical `server/prefetch-hints.json`, and per-segment
      // payloads within a few bytes of each other. It moves what the client
      // fetches at navigation time, which no build artifact records - so it cannot
      // move a number in this diff, and refusing the comparison would withhold
      // nothing while discarding every unrelated regression in the same PR.
      incomparable: false,
    })
  }

  if (
    before?.instantValidation !== undefined &&
    after?.instantValidation !== undefined &&
    before.instantValidation !== after.instantValidation
  ) {
    const lost = enforcesAtBuild(before.instantValidation) && !enforcesAtBuild(after.instantValidation)
    changes.push({
      key: 'experimental.instantInsights.validationLevel',
      before: before.instantValidation ?? 'unset',
      after: after.instantValidation ?? 'unset',
      summary: `instant validation ${lost ? 'weakened' : 'changed'}: ${before.instantValidation ?? 'unset'} -> ${after.instantValidation ?? 'unset'}`,
      // This one is worth saying out loud even though it emits nothing. At an
      // error level, a route that declares `instant` and then reads an
      // undeclared cookie fails the build outright. Below it, the same route
      // ships and the guarantee is gone with a green build - which is precisely
      // the class of change that gets noticed in production instead of in CI.
      explains: lost
        ? 'instant navigation is no longer enforced at build time: routes that break their `instant` contract now ship instead of failing the build'
        : 'how strictly Next checks the `instant` contract; no effect on emitted output',
      incomparable: false,
    })
  }

  if (before && after && before.sourceMaps !== after.sourceMaps) {
    changes.push({
      key: 'productionBrowserSourceMaps',
      before: String(before.sourceMaps),
      after: String(after.sourceMaps),
      summary: `browser source maps turned ${after.sourceMaps ? 'on' : 'off'}`,
      explains: after.sourceMaps
        ? 'per-file attribution is available again; module lists will appear where they were empty'
        : 'per-file attribution is gone; module lists will empty out without any code being deleted',
      incomparable: false,
    })
  }

  if (base.nodeMajor !== head.nodeMajor) {
    changes.push({
      key: 'node',
      before: String(base.nodeMajor),
      after: String(head.nodeMajor),
      summary: `Node changed: ${base.nodeMajor} -> ${head.nodeMajor}`,
      explains: 'the toolchain that produced the build; output can differ without source changing',
      incomparable: false,
    })
  }

  // A snapshot written before crust recorded configuration has none, and
  // "unset -> false" for a flag nobody touched is a fabricated change. Unknown
  // beats guessed: without both sides there is nothing to compare.
  if (!before || !after) return changes

  for (const key of new Set([...Object.keys(before.experimental), ...Object.keys(after.experimental)])) {
    const a = before.experimental[key]
    const b = after.experimental[key]
    if (a === b) continue
    changes.push({
      key: `experimental.${key}`,
      before: a === undefined ? 'unset' : String(a),
      after: b === undefined ? 'unset' : String(b),
      summary: `experimental.${key} changed: ${a === undefined ? 'unset' : String(a)} -> ${b === undefined ? 'unset' : String(b)}`,
      explains: 'an experimental flag that changes emitted output',
      incomparable: false,
    })
  }

  changes.push(...compareRouteConfig(base.routes, head.routes))
  return changes
}

/**
 * Per-route segment config: `dynamic`, `revalidate`, `runtime`, `fetchCache`.
 *
 * A route that went dynamic because someone wrote `export const dynamic =
 * 'force-dynamic'` is a decision, not a defect, and the diff should say which
 * one it is looking at.
 */
function compareRouteConfig(base: RouteSnapshot[], head: RouteSnapshot[]): ConfigChange[] {
  const beforeById = new Map(base.map((route) => [route.id, route]))
  const changes: ConfigChange[] = []

  for (const route of head) {
    const before = beforeById.get(route.id)
    if (!before) continue

    for (const key of new Set([...Object.keys(before.config), ...Object.keys(route.config)])) {
      const a = before.config[key]
      const b = route.config[key]
      if (a === b) continue
      changes.push({
        key: `${route.pattern} · ${key}`,
        route: route.pattern,
        setting: key,
        before: a === undefined ? 'unset' : String(a),
        after: b === undefined ? 'unset' : String(b),
        summary: `${route.pattern}: ${key} changed: ${a === undefined ? 'unset' : String(a)} -> ${b === undefined ? 'unset' : String(b)}`,
        explains: routeConfigExplains(key),
        incomparable: false,
      })
    }
  }

  return changes
}

/**
 * `instant` and `prefetch` govern navigation, not rendering. Saying "this route's
 * rendering was changed" about them would be confidently wrong in the one voice
 * the diff reserves for things it has proved.
 *
 * The key may arrive layout-prefixed (`app/layout.tsx:prefetch`), so the setting
 * is read off the end.
 */
function routeConfigExplains(key: string): string {
  switch (key.slice(key.lastIndexOf(':') + 1)) {
    case 'instant':
      return "this route's instant-navigation contract was changed deliberately; Next enforces it at build time only at an `experimental-error` validation level"
    case 'prefetch':
      return "this route's prefetching was changed deliberately by route segment config"
    default:
      return `this route's rendering was changed deliberately by route segment config`
  }
}

const major = (version: string): string => version.split('.')[0] ?? version

function partialPrefetchingExplains(after: boolean | 'unstable_eager'): string {
  if (after === 'unstable_eager') {
    return 'every `<Link>` now prefetches eagerly by default; navigation payload volume rises without any link changing'
  }
  if (after === true) {
    return 'prefetches now carry only the static part of a route, never its dynamic data'
  }
  return 'prefetches include dynamic data again, the pre-16.3 behaviour'
}

/**
 * The two `*error*` levels validate at build time; the `warning` levels only in
 * development. Crossing that line is the difference between a broken instant
 * route failing CI and shipping.
 */
const enforcesAtBuild = (level: string | null): boolean => level === 'experimental-error' || level === 'experimental-manual-error'
