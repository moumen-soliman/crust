# Contributing to crust

Thanks for helping improve crust. The project reads undocumented Next.js production artifacts, so
correctness and explicit uncertainty matter more than producing more output.

## Before you start

- Open an issue before starting a large feature or changing snapshot semantics.
- Keep changes focused. Avoid unrelated cleanup in the same pull request.
- Never turn missing evidence into a confident result. Report `unknown` and explain the gap.
- Measure production builds only. Development output is not valid performance evidence.

## Requirements

- Node.js 20 or newer
- pnpm 10
- Git

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

## Repository map

```text
src/
  adapters/       webpack and Turbopack artifact adapters
  analyze/        source parsing, cause chains, attribution and coverage
  shell/          predicted and emitted static-shell analysis
  diff/           compatible snapshot comparison
  findings/       prioritized single-build findings
  ci/             budgets and pull-request output
  report/         self-contained HTML report
  store/          snapshots and perf-history storage
  terminal-ui/    Ink terminal views
fixtures/
  basic/          Next 16, webpack/Turbopack, Cache Components on/off
  legacy/         Next 15 legacy rendering behavior
  monorepo/       aliases, workspace packages and barrel exports
test/             unit, integration, browser and production-build tests
site/             landing page
docs/             documentation
```

## Development workflow

Run the standard checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run one test file while iterating:

```bash
pnpm exec vitest run test/cause.test.ts
```

The HTML report controls are tested in Chromium:

```bash
pnpm exec playwright install chromium
pnpm exec vitest run test/report-explore.test.ts
```

## Test against real Next.js builds

Artifact shapes differ by Next.js version, bundler and rendering configuration. Unit tests alone are
not enough for adapter, shell, attribution or cause-chain changes.

Build the compatibility fixtures:

```bash
# Next 16 · webpack · Cache Components off
pnpm --filter crust-fixture-basic exec next build --webpack

# Next 16 · webpack · Cache Components on
CRUST_FIXTURE_MODE=cc pnpm --filter crust-fixture-basic exec next build --webpack

# Next 16 · Turbopack
CRUST_FIXTURE_MODE=turbo pnpm --filter crust-fixture-basic exec next build --turbopack

# Next 15 · webpack
pnpm --filter crust-fixture-legacy exec next build

# Next 16 monorepo · aliases and workspace packages
CRUST_FIXTURE_MODE=cc pnpm --filter @fixture/web exec next build --webpack
```

Then run:

```bash
pnpm test
```

Fixture build output is intentionally gitignored. Compatibility tests skip a case when its build
output is absent; CI builds every supported case before running the suite.

Smoke-test the packaged CLI rather than invoking `src/cli.ts` directly—the terminal renderer uses
TSX and plain Node cannot execute it:

```bash
pnpm build
node dist/cli.js analyze --cwd fixtures/basic --dist-dir .next-cc --no-save
```

## Engineering rules

### Preserve evidence

- Prefer emitted artifacts over source inference when both are available.
- Label conclusions `verified`, `inferred`, or `unknown`.
- Keep unresolved imports, opaque calls and conservative fallbacks visible.
- Do not parse or depend on opaque Next.js internals such as `postponedState`.
- Deduplicate warnings that originate from one shared chunk or root cause.

### Keep comparisons honest

- Compare only compatible snapshot schemas, Next.js majors, bundlers and rendering rule sets.
- Treat a new route as an addition, not a regression.
- Keep framework and build-configuration movement separate from application blame.
- Do not fail CI on an ambiguous direction or cause.

### Keep adapters fixture-backed

When changing artifact discovery or interpretation:

1. Add or update a production fixture that reproduces the artifact shape.
2. Pin route classification, shell discovery, attribution and cause relationships in
   `test/compat.test.ts`.
3. Ensure `.github/workflows/ci.yml` builds that fixture.
4. Add a focused unit test for the parser or normalization rule.

### Protect snapshot history

Snapshots outlive the version that created them. If a stored shape or its meaning changes:

1. Update the types in `src/store/snapshot.ts`.
2. Bump `SCHEMA_VERSION`.
3. Update factories, migration expectations and compatibility tests.
4. Document why old and new snapshots cannot be interpreted identically.

Do not silently reinterpret an existing schema.

## Code style

- TypeScript, ESM and explicit types at package boundaries.
- Follow the existing `.ts` import-suffix convention.
- Keep analysis functions deterministic and side-effect free where possible.
- Explain non-obvious artifact behavior in comments, including the real failure it prevents.
- Avoid adding configuration or dependencies unless the behavior cannot be expressed safely with
  the existing model.

## Documentation changes

Update the README and relevant docs when changing CLI flags, snapshot fields, supported artifact
shapes or user-visible conclusions. Public claims must match what is available in the terminal,
JSON, HTML report and CI—not only an internal helper.

The landing page lives in `site/`. Verify changes with:

```bash
pnpm --dir site build
```

## Pull-request checklist

- [ ] The change has focused unit tests.
- [ ] Artifact-sensitive behavior has a real production-build fixture.
- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` pass.
- [ ] The packaged CLI was smoke-tested when CLI or terminal code changed.
- [ ] Snapshot schema changes include a version bump and follow [COMPATIBILITY.md](COMPATIBILITY.md#bumping-the-schema).
- [ ] Unknown or unsupported cases remain explicit.
- [ ] README/docs were updated for user-visible behavior.
- [ ] User-visible changes have a `## [Unreleased]` entry in [CHANGELOG.md](CHANGELOG.md).

## Reporting bugs

Include:

- crust, Next.js and Node versions
- webpack or Turbopack
- whether Cache Components is enabled
- the command that failed
- the relevant crust warning or `--json` output
- a minimal reproduction or sanitized `.next` artifact shape when possible

Do not attach secrets, environment files or proprietary source maps to a public issue.

## Releasing

Releases are cut from `master` by pushing a tag. [`.github/workflows/release.yml`](.github/workflows/release.yml)
does the rest: it verifies, tests, packs, installs the tarball into a throwaway project to check the
executable a consumer actually gets, publishes with npm provenance, and opens the GitHub release.

Decide the version from [COMPATIBILITY.md](COMPATIBILITY.md) - while crust is `0.x`, breaking changes
to the CLI, the exports or the snapshot schema go in the minor position.

1. **Write the changelog section.** Rename `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to
   `## [X.Y.Z] - YYYY-MM-DD`, and open a fresh `## [Unreleased]` above it. The release workflow reads
   its notes from that heading and refuses to publish without it.
2. **Bump and tag.** `pnpm version minor` (or `patch`) writes `package.json`, commits, and creates
   the `vX.Y.Z` tag. Nothing else needs editing - the CLI takes its version from `package.json` at
   build time.
3. **Push.** `git push --follow-tags`.

**The tag decides the published version.** The workflow writes it into `package.json` before it
builds anything, so a hand-cut tag on a commit whose manifest was never bumped still publishes the
version the tag names. Step 2 is the convenient path, not a requirement, and there is no
version-mismatch failure to run into. The bump is not committed back to `master`: the tag is the
record, and a release job that pushes to a protected branch is a release job that fails.

What the tag cannot fix is a wrong tag. npm does not allow a version to be republished, so a typo
means burning that version number and cutting the next one.

Requires an `NPM_TOKEN` repository secret with publish rights. Provenance additionally needs the repo
and package to be public - that is what makes the published tarball traceable to the commit and the
workflow run that built it.
