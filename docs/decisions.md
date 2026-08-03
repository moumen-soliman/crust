# Resolved open questions

The plan (§12) left these open. Building answered them.

## Name

The product and binary are `crust`. The unscoped npm name was published and then unpublished by
someone else, so the package is `@moumensoliman/crust` while the installed executable remains `crust`.
No `next-*` name, per Vercel's trademark guidance.

## Adapter `onBuildComplete` - not needed

Phase 3 was planned against the adapter hook. Phase 0 showed the prerendered shell HTML is written
to `.next/server/app/**` unconditionally, with the fallback UI sitting in each hole and boundary
ids in document order. The shell engine reads files; no deployment adapter, no shim, no
undocumented API. `postponedState` was never parsed (zero `.postponed` files were even emitted).

## Turbopack stats - source maps only, and that is fine

There is no webpack-stats equivalent, but Turbopack's client-reference manifests are genuinely
route-scoped (webpack's are global) and its source maps attribute **99.8%** of bytes versus
webpack's 87.1%. Attribution on Turbopack is source-maps-only and *better*. The stamping
transform (R4) remains unbuilt on both bundlers; nothing in phases 1–7 needed it.

## Pages Router - detect-and-warn

Hybrid apps get their `app/` routes analysed with a warning that `pages/` is invisible to every
number. Pages-only apps get a refusal naming the non-goal, not a crash.

## CI on forks - same-repo pushes only

A fork PR's `GITHUB_TOKEN` is read-only on the base repository. The action posts the comment for
fork PRs but skips the `perf-history` push; `crust history push` itself reports and exits cleanly
when the push is rejected. Diffs still work from whatever snapshots the branch already has.

## Budget format - all three axes

`.perf/budgets.json` accepts absolute bytes (`firstLoadBytes`, `defaultFirstLoadBytes`),
percentage growth versus the baseline (`maxGrowth`), and shell ratio floors (`minShellRatio`,
`defaultMinShellRatio`). They answer different questions - "too big", "grew too fast", and
"stopped being static" - and a check that enforces only bytes passes a PR that halves the shell.

## Phase 1 exit criterion - restated

"Totals within 5% of `next build` output" died when Next 16.2 removed size columns from the build
output. The replacement: **first-load bytes must equal the sum of on-disk sizes of the route's
chunks plus shared root chunks**, which is what the analyzer computes and what the e2e fixtures
pin. Accuracy of *attribution* (which source produced the bytes) is tracked separately by the
spike's whole-build percentages: 87.1% webpack / 99.8% Turbopack.

## Regressions are enforced with no config; ceilings are not

Thresholds - how many kilobytes is too many, how small a shell is too small - cannot be guessed for
someone else's app, so they stay inert until `.perf/budgets.json` names a number. Regressions are a
different kind of statement: a route that was static and is now dynamic is a strict downgrade
against the project's own previous build, and it needs no threshold to be true. So mode drops,
cache regressions and a vanished shell fail CI as soon as a baseline exists, with no config file at
all.

The direction is only judged when it is certain, and there are three ways it is not. `unknown` has
no place on the staticness scale, so a transition into or out of it is reported and never failed.
Two builds flagged `incomparable` - different bundler, Next major or snapshot schema - get no
regression check at all, because every number moved for reasons the PR did not cause. And a newly
added route has a baseline of zero, so its whole size reads as growth; nothing got worse, because
there was nothing to get worse than. Ceilings still apply in all three cases: they describe one
build rather than a change. `allowRegression` in the budget file exempts named routes, as a list
rather than a global switch, so exempting one page cannot quietly exempt the app - and it exempts
only the zero-config rules. A configured `maxGrowth` is an explicit decision the project made, and
letting an implicit exemption switch it off would be crust overruling its user.

## `use cache` contains taint; it does not only suppress local fetches

The directive was originally honoured only for fetches written in the same file. The common shape
is the opposite: an uncached `fetchJson` helper, wrapped one file up by a cached `getProduct`. Taint
propagated straight through the wrapper and the page was reported dynamic.

Taint now stops at any module whose *every* value export is a `use cache` function - then the only
way an importer can reach anything inside is through a cache. The bar is all-or-nothing because
module granularity cannot tell which export the importer called, and the safe direction of that
error is to keep propagating; `export *` disqualifies a module outright, since "every export is
cached" is unknowable rather than true.

Containment applies to uncached-fetch taint and nothing else. A cache cannot cache `cookies()` -
Next rejects a dynamic API inside `use cache` at build time - so if one is written anyway, the
route still reads request state and the reason propagates through the contained module untouched.
Containing it would let a stray directive silently convert "this route reads request state" into
"this route is static", which is the failure the tool exists to report.

Measured on two real builds of the same fixture: the emitted shell is 100% static with the directive
and 45% without it. Before this the predictor said 45% both times - layer 1 disagreed with layer 2
in the cached build (`agreement: 0`), and the regression was only catchable from the emitted HTML.
Both builds now agree.

## `crust init` asks nothing and overwrites nothing

A "guided" setup command suggests prompts. It has none. Two reasons: the same command has to work
non-interactively (a piped shell, a container, someone else's CI), and every question a prompt would
ask is one crust can answer from the repository and then *report* - the package manager from the
lockfile, the app from the workspace, the baseline from `origin/HEAD`. A printed decision is
reviewable after the fact; an answered prompt is not.

What replaces the safety a prompt would provide: nothing existing is replaced without `--force`,
`--dry-run` prints the identical report while writing nothing, and the one question crust genuinely
cannot answer - which of several Next.js apps in a monorepo - stops the command and lists the
candidates instead of picking one.

Non-GitHub providers get a pasteable job under `.perf/ci/` rather than a written pipeline file.
GitLab and CircleCI keep the whole pipeline in one file, and appending to a file the project
maintains is how a setup command breaks a working build.

## Generated budgets explain themselves; the pin is the crust version

`.perf/budgets.json` carries a `"//"` array naming the derivation of every number, and marking which
ones crust *chose* rather than measured (`maxGrowth` is chosen; the first-load ceiling is derived from
the heaviest route). `readBudgets` ignores the key. Without it the file reads as authority: a
threshold nobody in review can explain is one nobody edits, and a generated number that hardens into
a standard is the exact failure the roadmap named. A threshold with nothing to derive it from - a
shell floor in a build that emitted no measurable shell - is left out with the reason, not defaulted.

Generated CI pins `@moumensoliman/crust` to the version that wrote the file, so a crust release cannot
change a project's verdict without a commit. The action ref stays `@main`: there is no release tag to
point at yet, and generating a reference to a tag that does not exist produces a workflow that fails
on its first run. The generated file says which half is pinned rather than implying both are.

## SQLite index - `node:sqlite`, not better-sqlite3

The plan named `better-sqlite3`; it is a native module and a version-conflict magnet. Node's
built-in `node:sqlite` keeps the dependency count at zero. On runtimes without it, every reader
falls back to scanning the per-file store - the index is an optimisation, never a capability.
