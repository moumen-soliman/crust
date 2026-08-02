# Historical visibility

Every item here is specified by **the text crust prints**, not by the capability it "supports". A
bullet that cannot be written as a block of real output is not specified yet - it is a wish.

The reason is commercial as much as technical. "Compare arbitrary branches" is a feature
description; the reader has to imagine the payoff. A PR comment that says
`/products/[slug] has regressed in 4 of the last 10 builds - same cause 3 times` *is* the payoff,
and it is also an unambiguous acceptance test. Write the output first, then build backwards to the
query that produces it.

Two rules follow from that:

- **Match the existing grammar.** Route blocks are `- key: **old → new**` lines under a
  `**\`/route\`**` heading, verdicts are `### crust: …`, footers are `<sub>`. New surfaces reuse
  that vocabulary so a reader who has seen one crust comment can read all of them.
- **Never print a number crust cannot attribute.** The 512 B noise floor (`NOISE_FLOOR_BYTES`),
  `Diff.incomparable[]`, and the off-scale `ROUTE_HANDLER`/`unknown` modes exist so crust stays
  silent rather than confident-and-wrong. Timelines multiply the chances of a bogus claim across N
  builds, so every aggregate below states its denominator.

## What already exists

Worth being exact, because four of the five items are closer than they look.

| Capability | Status |
| --- | --- |
| One snapshot per build, content-addressed | `.perf/builds/<shard>/<buildId>.json`, `SCHEMA_VERSION = 1` |
| Stable build identity | `buildId = shortHash(gitSha : dirtyHash : lockfileHash : nextVersion : nodeMajor : bundler : configHash)` |
| Queryable index | `.perf/index.db` (`node:sqlite`), tables `snapshots` + `route_totals`, index `route_totals_by_route` |
| N-build series per route | `SnapshotStore.routeHistory(limit = 30)` → `Map<routeId, {buildId, bytes, shellRatio}[]>`, oldest-first |
| Ref resolution | `resolve(ref, cwd)` - build id, git SHA, branch (via merge-base for `main`/`master`), `HEAD~N` |
| Squash-merge survival | `findBySourceSignature()` re-links a snapshot after its commit is rewritten |
| Off-host durability | orphan `perf-history` branch, `pushHistory()` / `fetchHistory()` |
| Bounded growth | `prune()` ladder - newest 50 full, then one per commit, module detail dropped after 90 days |
| Per-route trend rendering | HTML report `<th>Trend</th>` column, `renderSparklineSvg` over the last 30 builds |

The store is already a time series. What is missing is a **range query API** - `resolve()` returns
one snapshot - and the surfaces that read it.

---

## 1. Route performance timeline

**Detects.** Nothing; it reports. This is the read surface over `routeHistory`, which today only
feeds a sparkline with no labels, no dates, and no way to ask "which build was that dip?".

**Emits** - `crust timeline '/products/[slug]' --last 8`:

```text
/products/[slug]  ·  8 builds  ·  2026-07-24 → 2026-08-01

  build     when        first load          shell   change
  9f2c1ab   2026-08-01  241 kB  ████████     45%    +59 kB   rendering: static → partial
  a3f19c2   2026-07-31  182 kB  ██████      100%     +2 kB
  7c04e91   2026-07-29  180 kB  ██████      100%       -
  2e8ba13   2026-07-28  180 kB  ██████      100%    -12 kB   improvement
  b6f2201   2026-07-27  192 kB  ██████▌     100%     +8 kB
  1a9c7d4   2026-07-26  184 kB  ██████      100%       -
  d5e3f08   2026-07-25  184 kB  ██████      100%     +8 kB
  4b1d0e7   2026-07-24  176 kB  █████▌      100%    baseline

  1 regression · 1 improvement · net +65 kB across 8 builds
```

**Rules.** Bars scale to the max in the window, not to an absolute ceiling - the shape is the
point. `-` means the delta fell under `NOISE_FLOOR_BYTES`; it is not rounded to `0 kB`, because
"unchanged" and "changed by less than we can prove" are different claims. Builds whose snapshot is
`incomparable` to its predecessor print the row with a `·` in the change column and a footnote,
never a fabricated delta.

**New work.** A `timeline` command; a date per row (`Snapshot.committedAt` is `string | null`, so
rows use the store's existing `committedAt ?? createdAt` fallback - `routeHistory` returns neither
today); the report's `Trend` column linking through to the same series. Note the
existing sparkline is deliberately *equal-spaced by build, not by time* - the CLI keeps that and
labels the dates rather than silently switching to a time axis.

## 2. Compare arbitrary branches or commits

**Detects.** Every regression kind `diffSnapshots` already finds - the novelty is the *pair*, not
the analysis. Today `diff [ref]` compares the **current build** against a stored ref, so answering
"what did 2.3 → 2.4 do?" requires checking out and rebuilding 2.4.

**Emits** - `crust compare --base release/2.3 --head release/2.4`:

```text
### crust: 2 routes regressed, 1 improved

base  4b1d0e7  release/2.3  2026-07-24
head  9f2c1ab  release/2.4  2026-08-01

**`/products/[slug]`**

- rendering: **static → partial**
- static shell: **100% → 45%**
- first load: **241 kB** (+59 kB)
- Cause: `uncached fetch at lib/http.ts:3`
- Introduced by: `<ProductGallery>`

**`/dashboard`**

- first load: **198 kB** (+21 kB)
- Cause: `date-fns via components/Chart.tsx:12`

<sub>24 routes · next 16.2.1 · turbopack · 4b1d0e7 → 9f2c1ab</sub>
```

**Rules.** Output is the existing comment renderer with a two-line pair header substituted for the
`vs \`baseId\`` footer fragment - same route blocks, same verdict priority, so `crust compare`
piped into a PR reads identically to `crust ci`. Both refs go through `resolve()`, so
`--base v2.3.0 --head HEAD~5` works without special-casing tags.

**The honest caveat.** Cross-release pairs trip `Diff.incomparable[]` far more often than
adjacent-commit pairs do - a Next major, a bundler switch, or a `SCHEMA_VERSION` bump between two
tags makes the byte deltas meaningless. `compare` must lead with the `> [!WARNING]` block and print
**no** route deltas in that case, exactly as `ci` does. A release comparison that silently comments
across a webpack → Turbopack migration is worse than no feature.

**New work.** A `compare` command taking two refs; teaching the comment renderer a pair header.
Everything under it already exists.

## 3. Identify frequently regressing routes

**Detects.** A route whose first load or shell ratio regressed past `NOISE_FLOOR_BYTES` in **≥3 of
the last 10 snapshots**. Recurrence is reported per `Cause.kind` + cause string, so "regressed 4
times for 4 unrelated reasons" (a busy route) is distinguishable from "regressed 4 times because
the same import keeps coming back" (a real, fixable leak).

**Emits** - inline in the PR comment, as one extra line on a block that is already being printed:

```text
**`/dashboard`**

- first load: **241 kB** (+59 kB)
- Cause: `date-fns via components/Chart.tsx:12`
- Recurring: **4 of the last 10 builds** regressed this route - same cause in 3
```

and standalone, for a repo-wide view:

```text
$ crust hotspots --last 20

  route                    regressions   net      recurring cause
  /dashboard                  6 / 20    +112 kB   date-fns via components/Chart.tsx:12  (4)
  /products/[slug]            4 / 20     +59 kB   uncached fetch at lib/http.ts:3       (3)
  /settings/billing           3 / 20     +18 kB   -  (3 distinct causes)

  17 other routes had ≤2 regressions in this window.
```

**Rules.** One line, only on routes already regressing in this PR - this is context on a finding,
not a new alert, and it must never be the sole reason a comment appears. Denominators are always
printed (`4 of the last 10`), never a bare "frequently". A route with fewer than 10 snapshots in
the window says `4 of 6 builds` rather than extrapolating.

**New work.** All of it, but the data is in place: `route_totals` with `route_totals_by_route` is
already the right index for a per-route scan, and `prune()`'s "one per commit" tier keeps the window
meaningful rather than 20 rebuilds of the same commit.

## 4. Release performance summary

**Detects.** The aggregate of every snapshot between two refs - not a diff of the endpoints. A route
that regressed 40 kB mid-cycle and was fixed before the tag is *not* in the regression list, but it
is worth a line, because that is the story a release note should tell.

**Emits** - `crust summary --from v2.3.0 --to v2.4.0 --format md`, designed to paste into a release:

```markdown
## Performance - v2.3.0 → v2.4.0

38 builds · 24 routes · next 16.2.1 · turbopack

**Net:** 3 routes regressed, 5 improved, 16 unchanged. Total first load +38 kB (+1.4%).

| Route | First load | Shell | Note |
| --- | --- | --- | --- |
| `/products/[slug]` | 176 → 241 kB (+37%) | 100% → 45% | left the static shell |
| `/dashboard` | 177 → 198 kB (+12%) | 100% | `date-fns` via `components/Chart.tsx:12` |
| `/search` | 210 → 188 kB (-10%) | 62% → 88% | improved |

**Rendering modes:** 1 route left the static shell, 0 stopped being cached.

<sub>Recovered in-cycle: `/settings/billing` peaked at +40 kB in `b6f2201`, resolved by `1a9c7d4`.</sub>
```

**Rules.** `--format md` is the default because the destination is a release note. Regressions are
ordered by the same verdict priority the PR comment uses (mode drop, then shell, then cache, then
bytes), so the worst thing in the release is the first row. If any pair in the range is
`incomparable`, the summary reports across the comparable sub-ranges and says so, rather than
dropping the whole cycle.

**New work.** Range resolution (two refs → the ordered set of snapshots between them) is the one
genuinely new store primitive, and items 1, 3, and 4 all need it. Build it once as
`SnapshotStore.range(fromRef, toRef)` and these three become renderers.

## 5. Keep history readable without requiring SaaS

**Detects.** Nothing - this is the constraint the other four are built under, and it has a concrete
failure mode worth naming: `.perf/builds/<shard>/<buildId>.json` is content-addressed and sharded,
so `git log` on the `perf-history` branch is a wall of opaque hashes. Durable is not the same as
readable, and today crust is only the first one.

**Emits** - `crust log --last 5`, the missing "what happened lately" view:

```text
  9f2c1ab  2026-08-01  24 routes  1.8 MB   ⚠ /products/[slug] static → partial
  a3f19c2  2026-07-31  24 routes  1.7 MB     +2 kB
  7c04e91  2026-07-29  24 routes  1.7 MB     -
  2e8ba13  2026-07-28  23 routes  1.7 MB   ✓ /search 62% → 88% shell
  b6f2201  2026-07-27  23 routes  1.7 MB     +8 kB

  crust timeline <route>   per-route detail
  crust compare --base <ref> --head <ref>
```

and a generated `.perf/HISTORY.md`, refreshed by `crust history push`, so the orphan branch is
legible in the GitHub UI without cloning:

```markdown
| Build | Date | Commit | Routes | First load | Notable |
| --- | --- | --- | --- | --- | --- |
| `9f2c1ab` | 2026-08-01 | `9f2c1ab` | 24 | 1.8 MB | `/products/[slug]` static → partial |
```

**Rules.** Everything stays in the repo - no account, no ingest endpoint, no hosted dashboard, and
no network call in the read path. `HISTORY.md` is derived and regenerable; it never becomes the
source of truth, and it is excluded from `fetchHistory()`'s copy the way `index.db` already is.
`prune()` rewrites it after trimming so it cannot describe snapshots that no longer exist.

**New work.** `crust log`; `HISTORY.md` generation on push and prune. `list` already enumerates
snapshots - `log` is `list` with deltas and a verdict per row.

---

## Build order

`SnapshotStore.range(fromRef, toRef)` first - items 1, 3, and 4 are all renderers over it, and
building it once avoids three subtly different window definitions.

Then `compare` (item 2), which needs no new store work and is the cheapest thing to ship: it is
`diffSnapshots` plus a header. `log` and `HISTORY.md` (item 5) next, because they make the other
surfaces discoverable. `hotspots` and `summary` (items 3 and 4) last - they are the most valuable
to a reader and the most dependent on a correct window definition.
