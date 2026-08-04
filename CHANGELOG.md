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
