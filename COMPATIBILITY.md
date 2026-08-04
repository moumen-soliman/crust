# Compatibility policy

crust's output is only worth anything if a comparison across time is trustworthy. A regression check
that silently stops comparing reports "no regressions" in exactly the same voice it uses when there
genuinely are none. So this document states what may change in a release, what must not, and what
happens to a `.perf/` history you already have.

There are **four** versioned surfaces, and they do not move together.

| Surface | Version | Where it lives |
|---|---|---|
| CLI - commands, flags, exit codes | package semver | `crust --help` |
| Node API - `.` and the subpath exports | package semver | `exports` in `package.json` |
| Snapshot schema - the on-disk record | independent integer, currently **5** | `SCHEMA_VERSION` in [`src/store/snapshot.ts`](src/store/snapshot.ts) |
| Build inputs - Next.js, bundler, Node | support range, not semver | [README requirements](README.md#requirements) |

While the package is `0.x`, the minor position carries breaking changes and the patch position does
not. The rules below say what "breaking" means per surface; they tighten, not change, at 1.0.

## CLI

**Breaking** - needs a minor bump and a `### Changed` entry naming the old spelling:

- removing or renaming a command or flag
- changing a flag's default, or what an existing exit code means
- changing the shape of `--json` output, or of the markdown `ci --comment` writes (people diff and
  parse both)

**Not breaking:** new commands and flags, added `--json` fields, and terminal rendering. The terminal
view is presentation - it is expected to change, and is the reason `--json` exists.

Exit codes are load-bearing: `0` clean, non-zero on a budget breach or regression verdict. A command
that fails to *run* must not exit `0`, and a clean run must never exit non-zero.

## Node API

The subpath exports (`/widget`, `/collector`, `/ingest`, `/otel`) are public API under the same rules
as the CLI. Removing an export path, or narrowing an exported type, is breaking. Types are shipped;
a type-level break is a break even when the runtime behaviour is unchanged.

## Snapshot schema

This is the one that matters, because snapshots outlive the version that wrote them.

`SCHEMA_VERSION` is an integer that increments on **any** change to what a stored record means. It is
independent of the package version - a patch release can leave it alone, and it never resets.

Three mechanisms sit behind it, and a schema change has to be correct in all three:

1. **[`normalizeSnapshot`](src/store/normalize.ts)** brings older records up to the current shape as
   they are read. Absent stays absent: new fields default to empty, never to a guess. `config` stays
   `null` on a record that never had one rather than becoming `{cacheComponents: false, ...}`,
   because a baseline that recorded nothing is *unknown*, not *false* - defaulting it made the diff
   announce config changes that never happened.
2. **[`diffSnapshots`](src/diff/diff.ts)** refuses across the boundary. Differing `schemaVersion`
   produces `snapshot schema changed: vN -> vM - re-run \`crust analyze\` on the baseline commit`
   in `incomparable`, and the diff reports that instead of numbers.
3. **[`latestCompatibleBaseline`](src/diff/compatible.ts)** will not auto-select a mismatched record,
   so `analyze` reaches further back for a comparable one instead of silently picking a bad baseline.

`schemaVersion` is written to disk exactly as recorded and is never rewritten in place. Normalisation
happens in memory, on read. A stored snapshot is an immutable account of what a build was.

### Bumping the schema

A change that needs a bump:

- adding, removing or renaming a recorded field
- changing a field's units, or what it counts
- changing how a value is derived such that two releases would write different numbers for the same
  build

A change that does not: anything that leaves stored bytes identical for an identical build.

When bumping, in the same PR:

- increment `SCHEMA_VERSION`
- teach `normalizeSnapshot` to read the previous shape, or state in the changelog that it cannot
- add a fixture pinning the *old* shape as it was actually written, in full, like `V3_ON_DISK` in
  [`test/normalize.test.ts`](test/normalize.test.ts). Do not build it from the current factory: a
  factory-derived fixture silently acquires every field added after it, which is precisely the
  regression it exists to catch.
- add a `**[schema]**` changelog entry saying what an existing history does on upgrade

### What users should expect

Old records are **never** silently reinterpreted. Either they are read correctly, or the comparison
is refused with a message naming the fix. The remedy is always the same and always safe: re-run
`crust analyze` on the baseline commit. Superseded records can be left in place - they are skipped,
not misread - or cleared with `crust prune`.

## Build inputs

Next.js, the bundler and Node are inputs, not APIs, and they move on their own schedule.

- **Next.js:** two majors, currently 15 and 16, webpack and Turbopack. Outside that range crust
  refuses to run rather than interpret build artifacts it has not verified. Dropping a major is a
  minor bump with a changelog entry.
- **Node:** `>=20`, enforced by `engines`. Raising the floor is a minor bump.
- Manifest shapes and flight payload formats are undocumented Next internals that move on minor
  releases. The [nightly canary workflow](.github/workflows/canary.yml) exists to find that here
  rather than in a user's issue, and a fix for canary breakage is a patch.

Snapshots record `nextVersion`, `bundler` and `nodeMajor`, and comparisons across a Next major or a
bundler switch are declined for the same reason a schema mismatch is: the numbers are not measuring
the same thing.

## Releasing

Releases are cut by pushing a tag; [`.github/workflows/release.yml`](.github/workflows/release.yml)
publishes with npm provenance and opens the GitHub release from this version's `CHANGELOG.md`
section. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing) for the steps.
