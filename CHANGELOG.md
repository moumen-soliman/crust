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

- `package` CI job: the release tarball is packed, installed into a throwaway project, and driven
  through the generated `crust` executable. `node dist/cli.js` cannot catch a broken `bin`, `files`
  or `exports` field, because it never resolves the package the way a consumer does.
- The fixture job now analyses its builds through that installed executable as well.
- Release workflow (`.github/workflows/release.yml`): tag-triggered publish with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), plus an automatic
  GitHub release whose notes are this file's section for that version.
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
