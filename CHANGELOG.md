# Changelog

All notable changes to crust are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the rules in
[COMPATIBILITY.md](COMPATIBILITY.md) - which also covers the snapshot schema, versioned separately
from the package.

Entries that change how a snapshot is written, read or compared are marked **[schema]**, and say
what an existing `.perf/` history does on upgrade. Silent history invalidation is the one failure
this project cannot afford: a diff against a baseline that quietly stopped being comparable reports
"no regressions" for the same reason it would report a real one.

## [Unreleased]

## [0.2.1] - 2026-08-04

No schema change. CLI and terminal-output fixes only.

### Fixed

- `crust diff <buildId>` no longer claims a listed snapshot is missing when that id is the current
  head. Resolve refuses a build as its own baseline on purpose, but the error said "No stored
  snapshot found" — the same wording as a never-analyzed commit — so an id from `crust list` looked
  gone. Self-baseline is detected first and reported as incomparable, with a hint to pass another
  baseline or two stored ids.
- The terminal diff no longer emits React duplicate-key warnings when the same package or route
  appears more than once (for example `package:next` or `/` across added/grown rows). Chart and
  cause list keys include enough of the row identity to stay unique.

## [0.2.0] - 2026-08-04

No schema change: every axis added here reads fields the analyzer already wrote, so a `.perf/` history
recorded by 0.1.x gains the new comparisons **retroactively** with nothing to migrate. No published
export changed - `src/index.ts` is untouched, and everything below is CLI behaviour and output.

### Added

- `crust diff [base] [head]` takes two positionals, like `git diff a b`. With one, the head is still
  the build in `.next`; with two, both sides are read from the store and nothing is rebuilt.
  Comparing a release against a branch, or two stored snapshots against each other, no longer
  requires checking either one out. Either side accepts a branch, tag, commit or build ID.
- Package-level comparison. `Diff.dependencies` groups attributed package movement across the routes
  it reached, so a package that was added, removed or grew is stated once with its blast radius
  rather than once per affected route. The reported delta is the worst single route, never a sum:
  a shared chunk counts in the first load of every route it serves, and adding those together would
  report bytes nobody downloads. Requires source-map attribution; without it the list is empty, which
  is the same reason per-file attribution is empty.
- The PR comment leads with those package lines and **drops the route blocks they explain**. A route
  whose only movement is that package's bytes no longer restates the finding — it is still counted in
  the verdict and still fails its budget, but it does not get a block repeating a cause already
  named. A route that also lost caching, dropped out of the shell, or changed rendering mode keeps
  its block, because the package does not explain those.
- Two conditions on that suppression, so a dropped block never costs a reader the only statement of a
  cause. The package finding has to be **visible** — one collapsed into "and N more packages"
  explains nothing, and its routes keep their blocks. And it has to account for the **whole**
  movement: a route that gained 200 kB where the named packages explain 48 kB keeps its block for the
  other 152 kB. The rule lives in `diff/` and is applied by the comment and the terminal alike.
- `crust diff` shows the same grouping. A `PACKAGES` section above the route table, and the route
  detail those lines account for is dropped from `WHY IT MOVED` — grouping that printed above the
  rows it explained would only have made the output longer. The route keeps its row in
  `CHANGED ROUTES`; the inventory never loses an entry.
- Attribution sits beside the verdict in `crust diff`: `attribution 94%`, or `attribution 90% → 40%`
  when it moved. The share of client bytes traced to a file or a package — not the blended
  `confidence` the analyze view leads with — because that is the number the sections above it stand
  on. An empty `PACKAGES` section reads as "nothing moved" at 94% and as "nothing was measured" at
  10%, and those were previously indistinguishable.

- **Every command leads with the answer.** `crust diff main`, `crust diff v1.2.0 feature` and
  `crust ci main` now open with the same five things, derived once in `diff/lead.ts` and only
  rendered per surface: the decision, the changes behind it, the cause those changes share, how much
  of the build backs it up, and the likely next action.
  - **Decision.** One sentence naming the worst single thing, with a level - `BLOCK` for a route that
    stopped being static, stopped being cached, lost its shell, or broke a ceiling; `REVIEW` for
    movement with none of those; `CLEAR`; `CANNOT DECIDE` when there is no comparable baseline. It
    used to exist only in the PR comment, so `crust diff` opened with three counts and left the
    reader to find the answer in the route table.
  - **Improvements are led with, not folded away.** They share the changes list with regressions, and
    when nothing regressed they *are* the decision: "1 route improved, nothing regressed" where the
    old heading said "1 route changed". A route that became static again outranks one that shed 2 kB.
  - **Shared cause and blast radius.** Three or more regressions at one call site collapse into one
    line with the routes it reached, and it pays for itself: the comment prints blocks for the worst
    two of the group instead of one per route, each of which used to end in the same sentence. The
    grouping is derived from the diff, never from a snapshot's own `sharedCauses` - a provider that
    reaches nineteen routes in the head probably reached nineteen in the base, and calling that a
    cause of *the change* would be a guess.
  - **Coverage beside the verdict**, in the comment as well as the terminal, because it bounds what
    the verdict is worth.
  - **Source location and likely action** on every led change and every route block: the strongest
    location the evidence carries, then what to do. Where nothing can be blamed it states the missing
    evidence instead - "this build has no browser source maps" - because an instruction with nothing
    behind it costs more trust than an admission. One action per cause, never once per affected route.
- `crust diff` reads `.perf/budgets.json` so its decision is the one `ci` would reach on the same
  pair. It still only exits non-zero when a side has no snapshot; enforcement stays in `ci`.
- **Blocking-finding measurement log.** Every `ci` run that would fail the build appends those
  breaches to `.perf/findings.jsonl` with a stable key and a per-occurrence id. `crust findings
  list|agree|dispute|rate` marks each one and reports the disagreement rate over resolved rows only
  (`disputed / (agreed + disputed)`). An empty log reports the rate as unmeasured, never as 0% — the
  number Focus 3 requires still has to come from a live PR stream.
- **Client-boundary and barrel comparison**, the two remaining axes the analyzer measured and the diff
  never read. `Diff.clientBoundaries` names a component crossing from server to client with the
  subtree cost already measured; `Diff.barrels` names an import style with the count of files that
  reach a route *only* through the barrel, which is what deleting the import would actually save.
  Both group across routes and report the worst single route, like packages.
  - Every axis shares **one capped cause section** in both surfaces, so comparing another one can
    never add a section or lengthen the output.
  - Bytes are summed **within** an axis and maximised **across** them, because the axes nest: a
    boundary's subtree cost already contains the packages it imports, and crediting a route with both
    would explain 96 kB of a 48 kB regression and suppress detail for movement nothing named.
  - The lead names one route per cause rather than one per affected route. Found on a real build: a
    provider crossing to the client on three routes printed its fix three times over.

### Fixed

- A static → partial regression no longer tells the author to wrap the dynamic read in
  `<Suspense>` when that is already what produced the partial shell. Found by comparing
  two real commits of the Cache Components fixture: `/` dropped to partial via
  `cookies()` inside `<Theme>` under Suspense, and the lead still said "move it into
  Suspense". Partial now advises caching the read or accepting the hole.
- A cause that moved in both directions is two rows, not one. A package or boundary can shrink on one
  route and grow on another - a provider moved out of one layout and into another does exactly that -
  and a single row took the worst route's direction. It said "removed" while covering a route where it
  was *added*, and a reader who lost that route's detail on the strength of that line was told the
  opposite of what happened there. Each direction now gets its own row, its own worst route and its
  own radius.
- `changed` is no longer rendered as "grew". A package going 100 kB → 50 kB said "grew" beside a
  negative delta; the same applied to boundary subtrees and barrel costs.
- Barrel costs are no longer added together within their axis. Barrels nest -
  `components/index.ts` and `components/ui/index.ts` can each count the same dragged files - so
  summing them over-explained a route and suppressed detail for movement nothing named. The axis now
  credits its largest single contribution, like the across-axis rule. Packages still sum, because a
  file in `node_modules` has exactly one owning package; client boundaries no longer do, since two of
  them can import the same module.
- Actions and lead selection are ranked by what a cause did **on the route in front of you**. Both
  used each cause's worst route anywhere, so a package worth 200 kB on `/heavy` and 1 kB on `/a`
  supplied `/a`'s action and even collapsed `/a` out of the lead - a cause accounting for 2% of it -
  while the client boundary responsible for the other 98% went unmentioned.
- Barrel metadata is looked up by route id, not by pattern. With an alias plus a URL rename the two
  sides of the comparison hold different patterns for one page, so the baseline lookup missed and
  every file the barrel already dragged was reported as newly dragged.
- Dependency rows are one route's facts. `before`, `after` and `status` were per-package maxima
  collected independently of each other and of `delta`, so a package removed from one route and added
  to another reported the larger `before`, the larger `after` and `changed` - three numbers describing
  no build that exists, where `after - before` did not equal the delta printed beside them. Every
  number now comes from the worst single route, and the same rule covers the two new axes.
- The suppressed-block count no longer says "and 3 more" when no block was printed at all. With every
  block explained away by a cause line, "more" read as three regressions on top of three.
- Boundary actions are backticked, so the component name survives Markdown. GitHub parsed
  `<AnalyticsProvider>` as an HTML tag and rendered the sentence without it.
- Both refs of a two-reference comparison resolve from the refs. The anchor for a named ref was
  `merge-base HEAD <ref>`, which is the right question only while HEAD is the other side of the
  comparison — true for `ci` and for `crust diff <base>`, false the moment both sides are named. On a
  third branch, `crust diff feature release` answered with the commit the working copy happened to
  share with each ref: a build nobody asked about, reported as confidently as the right one. The
  one-ref form keeps merge-base semantics, because there HEAD *is* the head under review.
- The content-signature fallback no longer fires for a ref git does not recognise. It exists to
  re-link snapshots orphaned by a squash merge, where the ref is real and its ancestry is not; behind
  a branch that does not exist it answered with a snapshot of the current source, which reports "no
  regressions" for the one reason a reviewer would never suspect. A ref git cannot resolve now says
  so. It also no longer fires behind an explicitly named head, where matching on the head's source
  can answer "what is `release`" with a snapshot recorded on neither ref.
- The `diff` header names branch and short SHA for **both** sides on the comparable path, not only
  for the baseline and not only when the two builds cannot be compared. With two stored refs the head
  is no more "the current build" than the base is, and a bare pair of build IDs does not say which
  ref either one came from.

### Known limitations

- **The findings log is not concurrency-safe yet, so treat its denominator as a floor.**
  `.perf/findings.jsonl` is one mutable file, and `crust history push` overlays the local copy onto the
  history branch. Two CI jobs that start from the same tip therefore overwrite each other's rows, and
  because the second push is a fast-forward it reports success - a row can disappear with nothing in
  any log to say so. Proven with two clones of one remote: three rows expected, two on the branch. The
  fix is one file per run so the log inherits the merge behaviour snapshots already have.
- **`findings` keys are stable only for categorical breaches.** The key hashes the breach message, and
  the byte and percentage kinds interpolate measured values, so the same route over the same ceiling on
  two commits 200 bytes apart produces two keys. `rendering-mode` and `cache` group correctly; the rest
  group per occurrence.
- **A re-run of one CI job records its breaches twice.** Appends are not idempotent, which is right for
  two commits and wrong for a retry of one.
- **Attributed comparison still needs `productionBrowserSourceMaps: true`.** Without it, packages,
  client boundaries and barrels are all empty - the boundary axis included, since its subtree bytes come
  from the same attribution. The output states this rather than implying nothing moved.

## [0.1.7] - 2026-08-04

### Fixed

- `diff` and `ci` compare against the ref you named. Three faults in baseline resolution compounded
  into one symptom: every branch name reported a clean build.
  - Only the literal strings `main` and `master` were treated as branches. `develop`,
    `chore/crust-ci`, `release/*` - any other name - fell through to the ancestry fallback without
    ever being resolved.
  - That fallback walked `HEAD`, not the ref. So a question about another branch was answered with
    whatever was newest on the current one, and two different refs returned the same snapshot.
  - Nothing excluded the head build from its own baseline. `analyze` writes a snapshot for the commit
    being measured, so the record for `HEAD` is usually already stored; the walk found it first and
    compared the build against itself.
  A build diffed against itself reports `0 changed` under the same green tick a genuinely clean diff
  gets, which is the failure this file's preamble calls the one crust cannot afford - stated there
  about incomparable baselines, and true in exactly the same way of a baseline that was never the one
  requested. Refs now resolve through `git rev-parse` (branch, tag, or short SHA), anchor at
  `merge-base` so a moved-on base branch does not attribute its own commits to the pull request, and
  walk the resolved ref's ancestry rather than HEAD's. A ref git does not recognise returns no
  baseline instead of a substituted one, which surfaces as the "no stored snapshot" warning that
  should have been printed all along. Found by running `crust diff` against a real repository with
  two feature branches, not by a test.
- A clean snapshot beats a dirty one at the same commit. Both are stored, `resolve` took whichever
  `list()` happened to return first, and uncommitted work is not what a branch contains.

### Changed

- The `diff` header names the baseline's branch and short SHA beside its build ID
  (`8419459abc25c9ef (chore/crust-ci@ff3ef93b) → c11296307919edf0`). Build IDs are opaque, so a
  baseline resolved from the wrong branch was indistinguishable from the right one without running
  `crust list` - which is most of why the faults above survived as long as they did.

**What an existing `.perf/` does on upgrade:** nothing is rewritten, re-read, or invalidated, so this
is not a schema event. Verdicts can change, and that is the point: a repository that was comparing
against the wrong baseline - or against itself - starts comparing against the right one, and a
project whose named branch has no snapshot starts being told so instead of shown a clean result. Runs
that were already resolving correctly are unaffected.

## [0.1.6] - 2026-08-04

### Added

- Complete cause chains reach CI. The analyzer already walked the module graph and stored the route →
  component → import → call-site chain for every finding; the diff threw it away and rebuilt a single
  line from the delta. `RouteDelta` now carries the stored chain, matched to the finding by call site,
  and the PR comment folds it behind a disclosure under the one-line summary - the verdict still
  leads, the import path is one click away. A chain that cannot be matched is left off rather than
  approximated, because a reviewer follows an import path, and one attached to the wrong finding sends
  them somewhere real that is not where the problem is. Where the chain names the nearest rendered
  component and the one-line heuristic could not, the chain fills it in; it never overwrites a
  component the emitted shell verified.

### Fixed

- One finding is stated once. A route segment declaration was reported three times in the same
  comment: in the configuration note, as a `Declared:` line on the route, and again as the `Cause:`.
  The note now carries build-level configuration only - segment config already sits beside the route
  it governs - and the `Cause:` line is dropped when it merely restates a declaration that shows the
  before and after values. A declaration on a route that gets no block of its own is still reported in
  the note, because there is nowhere else for it to appear. Found by reading a real pull-request
  comment rather than the tests.
- The comment footer says "1 route" rather than "1 routes".

## [0.1.5] - 2026-08-03

### Fixed

- A route declaring `dynamic = 'force-dynamic'` is classified as dynamic instead of `unknown`.
  Next lists such a route in neither `prerender-manifest.routes` nor `dynamicRoutes` - being opted
  out of prerendering is *why* it is absent - so the classifier had no artifact and refused to guess.
  An `unknown` transition is reported but never failed, which meant the most explicit way there is to
  make a route dynamic was the one case `crust ci` stayed silent about: the recipe in crust's own
  documentation and in `crust init`'s closing step ("add `export const dynamic = 'force-dynamic'` to a
  static page ... it exits 1") did not exit 1. A declaration in the source is stronger evidence than
  the absence of a manifest entry, and a declaration on a layout is honoured for the routes beneath
  it, naming the layout as the cause. Found by running the documented recipe against a real
  application instead of trusting it.

## [0.1.4] - 2026-08-03

### Added

- `crust init`: guided setup from an installed package to an enforcing check. It picks the Next.js
  app (and refuses to guess between several in a monorepo), verifies a production build exists,
  records the first snapshot, reports whether source-map attribution is available, writes starter
  budgets, and generates CI configuration for the detected provider. Nothing existing is replaced
  without `--force`, and `--dry-run` prints the same report while writing nothing.
  - Generated budgets carry a `"//"` array explaining how every number was derived, and which of
    them crust *chose* rather than measured. A generated threshold nobody can explain in review is
    one that hardens into a standard by default, which is the opposite of the intent.
  - Generated CI pins `@moumensoliman/crust` to the version that wrote the file, so a crust release
    cannot change a project's verdict without a commit. It builds with the detected package manager,
    defers to the `packageManager` field where one exists, and runs on the base branch as well as
    pull requests - without that, a pull request has no merge-base snapshot to compare against.
- `crust-version` input on the bundled GitHub Action, which is what makes that pin possible. Empty
  (the default) tracks latest, as before.
- The PR comment explains build configuration instead of only reacting to it. Comparable changes get
  their own note, labelled as evidence and explicitly not attributed to application code; incomparable
  ones keep the warning block but now say what each *explains*, so "no deltas were reported" cannot
  read as "nothing happened". A route that regressed because it declared `dynamic`, `revalidate`,
  `runtime` or `fetchCache` still fails, with the declaration named beside the mode drop - the
  reviewer is no longer sent looking for an uncached fetch that does not exist. The heading counts
  configuration changes too, because `crust: no change` was false on a build whose configuration
  moved. This completes Milestone 2.

### Fixed

- The documented and generated workflows referenced `moumen-soliman/crust/action@main`, and this
  repository has no `main` branch. Every copy of that YAML failed on "unable to resolve action"
  before running a step, so the documented CI setup had never worked. Now `@master`, asserted in the
  generator's tests.
- Baseline resolution prefers a snapshot the comparison can actually use. One commit can carry
  several - every `analyze` and `ci` run on it writes one, and a crust from before a schema bump left
  records the current comparison refuses - and `resolve` returned whichever came first. A project
  whose history contained an older-schema snapshot for its base commit got "baseline not comparable,
  so nothing to compare" on every pull request, with a usable snapshot for the same commit sitting in
  the store. Found by running the check on a real repository rather than a fixture.
- `crust init` reports whether a *comparable* baseline exists rather than counting stored snapshots.
  Counting them told a project it was set up while its first CI run had nothing to compare against,
  and named the reason - schema, bundler, or Next major - only in the CI output, one step too late.
- `crust init --cwd` on a path that does not exist says so, instead of falling through to the
  workspace scan and reporting a different app entirely.
- Long step details in the `init` report no longer lose their status glyph. Ink re-lays out a row of
  text that overflows, and the separating spaces are the first thing it drops.
- `package` CI job: the release tarball is packed, installed into a throwaway project, and driven
  through the generated `crust` executable. `node dist/cli.js` cannot catch a broken `bin`, `files`
  or `exports` field, because it never resolves the package the way a consumer does.
- The fixture job now analyses its builds through that installed executable as well.
- Release workflow (`.github/workflows/release.yml`): tag-triggered publish with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), plus an automatic
  GitHub release whose notes are this file's section for that version. The published version is
  taken from the tag and written into `package.json` before the build, so the tag and the package
  cannot disagree and there is no manual bump step that can be skipped.
- `CHANGELOG.md` and `COMPATIBILITY.md`.

### Changed

- The tool version has one source. `package.json` is inlined into `src/version.ts` at build time by
  tsup and vitest alike, replacing the hand-maintained constant in the CLI and the literals in the
  test factories. The constant had to be edited in lockstep with a release to keep `toolVersion`
  honest, and nothing enforced that.
- `bin.crust` is `dist/cli.js` rather than `./dist/cli.js`. npm 11 rewrites the `./` form on publish,
  so this changes nothing for installed users; it makes the manifest correct before the repair.
- CI runs on pushes to `master`, which is the branch this repository actually uses. The old `main`
  trigger matched no branch, so nothing ran on push.

### Documentation

- Baseline refs default to `main` because that is the default branch name in *consumer*
  repositories; crust itself develops on `master`. Both resolve through `git merge-base`. This is now
  stated in the README, the Action input description, and at the call site.
- Removed a Tailwind component-porting guide that had been appended to `CONTRIBUTING.md` from an
  unrelated project.

## Earlier releases

0.1.3 and before predate this changelog. Their contents are recoverable from
[the commit history](https://github.com/moumen-soliman/crust/commits/master) and the published
[npm versions](https://www.npmjs.com/package/@moumensoliman/crust?activeTab=versions).

One schema event in that stretch is worth stating explicitly, because it is still capable of
surprising anyone carrying an old `.perf/` directory.

### 0.1.2 - **[schema]** snapshot schema v1 → v4

Snapshots written by 0.1.1 and earlier record schema v1; 0.1.2 and 0.1.3 record v4. The store still
*reads* v1 records - `normalizeSnapshot` fills in `config`, `sharedCauses`, `coverage`, per-route
`modules`/`causes`/`barrels`, and maps the old `clientBoundaryRoots` onto `clientBoundaries` - but
`diffSnapshots` refuses to compare across the version boundary, and `latestCompatibleBaseline` will
not select a v1 record as an automatic baseline.

**Migration:** re-run `crust analyze` on the baseline commit to write a current-schema record.
Nothing is lost by leaving the v1 files in place; they are skipped, not misread. The refusal is
deliberate - a v1 record has no `config`, so comparing it against a v4 head would have reported
"browser source maps turned on" and a handful of experimental-flag changes that never happened.
