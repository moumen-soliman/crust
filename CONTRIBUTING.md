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
- [ ] Snapshot schema changes include a version bump.
- [ ] Unknown or unsupported cases remain explicit.
- [ ] README/docs were updated for user-visible behavior.

## Reporting bugs

Include:

- crust, Next.js and Node versions
- webpack or Turbopack
- whether Cache Components is enabled
- the command that failed
- the relevant crust warning or `--json` output
- a minimal reproduction or sanitized `.next` artifact shape when possible

Do not attach secrets, environment files or proprietary source maps to a public issue.
# Contributing - the porting recipe

Every component here is **fully Tailwind** (no CSS files, no custom classes) and
animates with **[motion/react](https://motion.dev)**. `apps/web/app/globals.css`
is the only stylesheet, and it holds only `@import`, `@source`, `@theme` (tokens
+ site-chrome keyframes) and `@layer base` element resets. CI (`pnpm check`)
fails the build if a custom class appears anywhere.

## Animation policy

- **motion/react** for anything state-driven: enters/exits (`AnimatePresence`),
  layout glides (`layout` / `layout="position"`), keyframe-style effects
  (`initial`/`animate`), scroll-linked visuals (`useScroll` + `useTransform`),
  and measured morphs (the imperative `animate()`).
- **CSS transitions** stay ONLY for pure hover/focus styling (colors, box-shadow,
  background) - never for state-driven movement, opacity, or reveals. Every
  component uses motion; every registry item lists `"motion"` in dependencies.
- Wrap the component root in `<MotionConfig reducedMotion="user">` and guard
  imperative sequences with `useReducedMotion()`.
- Add `"motion"` to the registry item's `dependencies`.

This guide is the repeatable recipe for adding or porting a component.

## 1. Scaffold

```bash
cd apps/web
pnpm new:component "Radial Dial" radial-dial
```

You get:

- `registry/lab/radial-dial/radial-dial.tsx` - the installable component (keep it free of demo data)
- `registry/lab/radial-dial/example.tsx` - the usage example: demo props/data live HERE, and this file renders in the page's Usage box. Show the full prop surface: one instance per meaningful variant (mask, fixed width, align, adapters…), each with a one-line comment saying what it demonstrates
- `src/showcases/radial-dial-showcase.tsx` - the live demo (imports the example's data)
- `registry.json` + `src/showcases.tsx` wired

No route or config edits - the `/components/[slug]` route and `registry-data.ts`
pick it up automatically. Update the `description` in `registry.json` (one line -
it's what the CLI and OG tags show). If it has a clip, drop it in `public/lab`,
run `pnpm blurs`, and add it to the `videos` map in `src/registry-data.ts`.

## 2. Write the component (Tailwind only)

The component in `registry/lab/<slug>/<slug>.tsx` is copied verbatim into a
user's project, so it must be self-contained: inline its icons, import nothing
from the repo, and rely only on the shared `lab-theme` tokens
(`ease-smooth-out`, `shadow-border`, the `animate-*` keyframes). If it uses hooks
or event handlers, start the file with `"use client";` so it works when a user
drops it into a Next.js Server Component (the scaffolder adds this by default).

### Mechanical CSS → Tailwind mapping

| Source pattern | Tailwind |
| --- | --- |
| plain declarations | utilities / arbitrary values (`bottom-[0.4375rem]`) |
| `:hover` / `:focus-visible` / `:active` | `hover:` `focus-visible:` `active:` |
| parent-state selector (`.x[data-open] .y`) | named group: `group/x` + `group-data-[open=true]/x:` |
| ancestor `:hover` drives descendant | `group/item` + `group-hover/item:` |
| static CSS var | inline the value |
| JS/prop-driven CSS var | `style={{ "--v": v }}` + `[prop:var(--v)]` |
| `@keyframes` | add `--animate-*` + `@keyframes` to `styles.css` `@theme`, and to the item's `css` in `registry.json` |
| `prefers-reduced-motion` | `motion-reduce:` |
| `@starting-style` | `starting:` |
| `mask-image`, scroll-snap | `[mask-image:…]`, `snap-y snap-mandatory` |
| `0fr → 1fr` grid morph | `grid-rows-[0fr] data-[open=true]:grid-rows-[1fr] transition-[grid-template-rows]` |
| CSS `content` swap | `after:content-['flex:_1'] group-hover/item:after:content-['flex:_5']` (`_` = space) |

### Gotchas learned porting

0. **`blur-0` does not exist in Tailwind v4** - it silently compiles to nothing,
   so a `hover:blur-0` "un-blur" end state never applies and the element stays
   blurred. Use `blur-[0px]` (interpolates cleanly in filter transitions).


1. **Tailwind v4 animates via native `translate` / `scale` / `rotate` properties**,
   not `transform`. A `transition: transform` will NOT animate `-translate-x-1/2`
   or `scale-[…]`. When a transform changes and must animate, use an **arbitrary
   transform** so it stays one property:
   `[transform:translate(-50%,-50%)_scale(0.88)]` +
   `group-hover/x:[transform:translate(-50%,-50%)_scale(1)]` +
   `[transition:transform_300ms_var(--ease-smooth-out)]`.
   (A bare `rotate-180` on a static toggle is fine - transition `rotate`.)

2. **Gate hover to hover-capable devices** to match `@media (hover: hover)`.
   Tailwind's plain `hover:` already does this, but `group-hover` does not - stack
   the media variant: `[@media(hover:hover)]:group-hover/card:opacity-100`.

3. **`backdrop-filter` with multiple functions** (blur + saturate) is cleaner as
   an arbitrary property than composing Tailwind's `backdrop-*` utilities:
   `[backdrop-filter:blur(16px)_saturate(1.7)]`, transitioned via
   `[transition:backdrop-filter_350ms_var(--ease-smooth-out)]`.

### 100% coverage ledger (required)

Open the component's block in the original `moumendev/src/styles.css` and walk it
selector by selector against the class list in the plan's Appendix. Every class
must be converted or explicitly dropped with a reason (e.g. a keyframe replaced by
a transition). Nothing may be silently skipped.

## 3. Base UI

Use `@base-ui-components/react` only where a component maps to a real primitive
(Popover, Dialog, Menu) - it replaces overlay/positioning/dismiss/focus
scaffolding while the visual morphing stays custom. Add it to that item's
`dependencies` in `registry.json`. Most components stay pure React.

## 4. Verify

```bash
pnpm check          # zero-custom-CSS + registry invariants
pnpm --filter web typecheck
pnpm --filter web build
```

Then compare the page against the original side by side (moumendev on `:5173`,
this app on `localhost:3000`) across hover, focus-visible/Tab, active, inspect and
reduced-motion. Install it into a scratch Next.js + Tailwind v4 app to confirm the
copied file renders on its own:

```bash
MOUMENLAB_REGISTRY=http://127.0.0.1:4173 node packages/moumenlab/dist/index.js add <slug>
```
