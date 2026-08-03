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

0.1.4 and before predate this changelog. Their contents are recoverable from
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
