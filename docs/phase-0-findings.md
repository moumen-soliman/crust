# Phase 0 findings

Measured against `fixtures/basic` on **Next.js 16.2.12**, React 19.2.8, Node 25, pnpm 10.33.
Four builds from one fixture: webpack and Turbopack, each with and without `cacheComponents`.

Reproduce with:

```bash
node spike/phase0.ts fixtures/basic .next
```

## Verdict

**Phase 1 proceeds as planned.** The kill criterion (≥85% module attribution) passes on both
bundlers. The shell engine's dependency — readable shell artifacts — is confirmed and turned out to
need no adapter hook at all.

| Question | Answer |
|---|---|
| route → chunk → module → source? | Yes, both bundlers, by different mechanisms |
| Attribution accuracy | webpack **87.1%**, Turbopack **99.8%** |
| Usable shell artifacts? | Yes — plain HTML on disk, no `postponedState` needed |
| Turbopack viable? | Yes, and *better* than webpack for source attribution |

## 1. Source-map attribution clears the bar on both bundlers

Whole-build byte attribution, `productionBrowserSourceMaps: true`:

| Bundler | Attributed | Total | Rate |
|---|---|---|---|
| webpack | 754.0 kB | 866.1 kB | **87.1%** |
| Turbopack | 627.6 kB | 628.9 kB | **99.8%** |

webpack's shortfall is almost entirely one file: `polyfills-*.js` (110 kB) ships with no source map.
That is a fixed, identifiable cost, not scattered noise — it can be labelled rather than counted as
unknown. Excluding it, webpack is ~99.6%.

**Turbopack beats webpack here.** R4 assumed Turbopack would be the weak side for attribution. For
source maps that is simply not true, and the risk should be downgraded accordingly. R4's actual
scope is narrower than written: it is about the *stamping transform*, not attribution generally.

### The trap that made Turbopack look impossible

Turbopack names source maps independently of their chunk:

```
3cqmf8g-py4nf.js   ->   sourceMappingURL=3ixj0_2my9s3k.js.map
```

Guessing `chunk + '.map'` — the obvious implementation, and webpack's actual convention — finds
nothing and reports **17.5%** attribution on Turbopack. The `sourceMappingURL` comment is the only
correct link. Reading it takes Turbopack from 17.5% to 99.8%.

Had the spike stopped at the obvious implementation, it would have produced a false kill signal for
the entire Turbopack half of the tool.

### Identifying first-party code is not a prefix check

The two bundlers anchor source paths differently, and `TraceMap` resolves source URLs, which
collapses the distinction:

| Bundler | Raw source URL |
|---|---|
| webpack | `webpack://_N_E/./components/Gallery.tsx` |
| webpack (Next's own code) | `webpack://_N_E/../../../src/shared/lib/router/router.ts` |
| Turbopack | `turbopack:///[project]/…/fixtures/basic/components/Gallery.tsx` |

Next ships source maps pointing into **its own `src/`**, so any `!path.includes('node_modules')`
heuristic reports Next's router and segment cache as the user's application code. The first version
of the spike did exactly this and confidently listed `src/client/components/app-router.tsx` as
first-party.

The reliable test is whether the path resolves to a file that **actually exists in the project**,
matching the longest suffix first. That is scheme-agnostic and cannot be fooled.

Note Turbopack's `[project]` root is the inferred *workspace* root, not the app directory, whenever
an outer lockfile exists — so the path prefix is not stable even within one bundler.

## 2. Route → chunk works on both, by opposite mechanisms

This is the sharpest confirmation of R2 so far, and it justifies the adapter seam existing from the
first commit.

| | webpack | Turbopack |
|---|---|---|
| `static/chunks/app/**` mirrors the route tree | **Yes** | No — flat, content-hashed names |
| `clientModules[src].chunks` populated | Yes | Yes |
| …but route-scoped | **No — global** | **Yes** |
| Chunk list format | `[id, path, id, path]`, URL-encoded (`%5Bslug%5D`) | flat, `/_next/`-prefixed |

The webpack manifest for `/dashboard` lists `static/chunks/app/page-*.js` — a chunk belonging to a
different route. Its `clientModules` map is the whole app's client module table, so unioning its
chunk lists **over-attributes**. Turbopack's manifest is genuinely per-route: `/dashboard` reports
2 chunks where `/` reports 3.

So:

- **webpack**: route → chunk comes from the path convention; the module graph is needed to scope the
  manifest's chunk lists to a route.
- **Turbopack**: route → chunk comes straight from the client-reference-manifest; there is no path
  convention to fall back on.

Neither mechanism is a substitute for the other. Two implementations, one interface — as planned.

### Manifests that do not exist in Next 16

The plan's reading list is out of date:

- **`app-build-manifest.json` is gone.** There is no route → client chunk manifest at the top level.
- `build-manifest.json` contains only `polyfillFiles` / `rootMainFiles` / `lowPriorityFiles` and an
  empty `pages: { "/_app": [] }`. It carries no App Router route information at all.
- `app-path-routes-manifest.json` (entry → URL pattern) is the useful one and was not in the plan.
- Turbopack additionally emits per-route `server/app/<route>/build-manifest.json`, but those contain
  only `rootMainFiles` — identical for every route, so not useful for attribution.

**`next build` no longer prints size columns.** Next 16.2's route table is just route names and
rendering-mode glyphs. The Phase 1 exit criterion "totals within 5% of `next build` output" has no
output left to compare against and needs restating — most likely against the sum of on-disk chunk
bytes reachable from a route.

## 3. Shell artifacts are readable, and need no adapter hook

With `cacheComponents: true`, both non-static routes become `◐ Partial Prerender` and the build
writes ordinary HTML to `.next-cc/server/app/**`. For `/products/alpha`:

```html
<main>
  <h1>Product alpha</h1>
  <!--$?--><template id="B:0"></template>
  <p id="gallery-fallback">Loading gallery…</p><!--/$-->
</main>
```

Everything the plan predicted, confirmed:

- `<Hero>` (`<h1>`) is **in** the shell — the predicted-static component really is prerendered.
- The Suspense hole is marked `<!--$?-->`, with the fallback sitting exactly where the hole is.
- Boundary IDs (`B:0`) are assigned in document order, so they map back to shell positions and to
  the runtime `$RC("B:0","S:0")` swap calls that layer 3 will observe.
- **`postponedState` was never needed and never touched.** Zero `.postponed` files were emitted;
  the HTML alone is sufficient for layer 2.

**Open question resolved:** the adapter `onBuildComplete` hook is *not* required for Phase 3. The
shell HTML is on disk at a predictable path. This removes the plan's stated dependency of Phase 3 on
a deployment-adapter shim, and removes an undocumented-API dependency from the flagship feature.

### One trap

For a route with `generateStaticParams`, the build emits **both** `products/[slug].html` (the
unparameterized fallback shell, **0 bytes**) and `products/alpha.html` / `products/beta.html` (real
shells, 1.0 kB each). Diffing against the `[slug]` file compares against nothing and would report
that the entire shell vanished. Layer 2 must diff against a parameterized shell.

## 4. The fixture reproduced a real barrel-file defect immediately

`app/page.tsx` imports only `Hero` from `components/index.ts`. Attribution says:

```
/
     0.2 kB  components/Counter.tsx
     0.2 kB  components/Gallery.tsx
```

Both client components ship to the home route, which renders neither. `next/image` comes with them,
pulling the 15.1 kB shared chunk `619-*.js` onto a route that has no images.

This is R1's hard case behaving exactly as feared — and it is also the single clearest demonstration
of why the tool is worth building. It is a strong candidate for the README's headline example.

## 5. What real projects changed

Fixtures validated the mechanisms. Two real codebases — a 25-route Turborepo on Next 16.2.6 with
Turbopack, and a 6-route app on Next 15.5.21 with webpack — found bugs no fixture would have.

**`searchParams` cannot be detected by identifier.** Matching the bare name flagged
`url.searchParams`, ordinary function parameters that happen to share the name, and client-side
`useSearchParams()` results. One shared string utility with a `searchParams` parameter tainted
almost every route in the app. It is only a dynamic API when destructured from a **page
component's props**, so that is the only form now matched.

**Prefix-matching route patterns is catastrophically loose.** Deciding "partially static" by
testing whether a prerendered route starts with `pattern.split('[')[0]` truncates `/[locale]/about`
to `/`, which every prerendered route starts with. All 25 routes reported as partially static. The
prerender manifest's `srcRoute` names the dynamic pattern exactly and is now used instead.

**Module-level taint must not condemn a component.** Inferring that a component is dynamic because
its *file* transitively imports something dynamic reported `<RootLayout>` as a hole on every route —
true under module granularity, and useless, since a root layout imports a shared service in
practically every real app. Transitive taint still decides boundary children, where it is the right
granularity; it no longer condemns a component outright.

**Next 15 still has `app-build-manifest.json`.** It is present in the 15.5.21 build and absent in
16.2.x, confirming the manifest set genuinely differs across the two supported majors rather than
the plan simply being out of date.

**Most projects have no production source maps**, so module attribution is unavailable by default.
Route totals, rendering modes, dynamic-route blame and shell composition all still work; the tool
reports the gap per chunk instead of guessing. This is a bigger deal for adoption than the fixtures
suggested — the headline feature needs one config line that most projects do not have.

## Consequences for the plan

**Downgrade R4.** Turbopack source-map attribution is excellent. R4 applies only to the stamping
transform, which remains unproven and stays out of Phases 1–4.

**Upgrade the manifest reading list.** `app-build-manifest.json` does not exist; the client
reference manifest and `app-path-routes-manifest.json` replace it. The plan's stated read order
needs rewriting before Phase 1 code is committed against it.

**Phase 3 gets cheaper and safer.** No adapter hook, no `postponedState`, no undocumented API — just
HTML on disk.

**Phase 1 needs a new exit criterion**, since `next build` no longer prints the sizes it was meant to
be checked against.

**Still unproven, deferred as planned:** the stamping transform (R4), monorepo and tsconfig-path
attribution (the third Phase 0 fixture, not yet built), and whether webpack's module graph can scope
the global client-reference-manifest to a route without a webpack plugin.
