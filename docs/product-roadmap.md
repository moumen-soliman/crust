# Crust product roadmap

## Positioning

> Next tells you what it built. Crust proves why it changed, shows everything affected, and decides whether it should merge.

Crust is build-causality and merge-intelligence tooling for Next.js. It explains why rendering, caching, shell composition, and client JavaScript changed—and turns that evidence into a trustworthy merge verdict.

## Implementation status

Milestone 1 is implemented. Milestone 2's shared causes, client cost, configuration detection, and
single-build report controls are implemented; explicit config explanations in every `diff`/CI view
remain follow-up work. Milestone 3 has started: `crust init` is implemented. Milestone 4 remains
planned.

## Product principles

1. **Evidence before presentation.** Improve artifact discovery and source relationships before adding more terminal or report output.
2. **Delta before inventory.** Lead with what changed; keep complete route tables behind progressive disclosure.
3. **Unknown before guessed.** Ambiguous relationships must remain explicit instead of becoming confident-looking claims.
4. **Action before observation.** Every finding should name what caused it, what it affected, and what the developer can do next.
5. **CI must be quiet and trustworthy.** Fail only on comparable, evidence-backed regressions or explicit project budgets.

## Priority 1: Complete cause chains

Show the source relationship from a route to the call or import responsible for its behavior.

### Dynamic rendering

```text
/courses/[slug]
→ <CoursePage>
→ imports _GetCourseData
→ packages/core/src/services/Course.ts
→ uncached fetch at packages/core/src/services/index.ts:29
→ route became dynamic
```

### Client JavaScript growth

```text
/packages
→ <PackagePage>
→ <PackageCard>
→ barrel import @repo/ui/icons
→ PackagesThumbnails.tsx
→ +221 kB
```

### Requirements

- Preserve local and imported binding names through the module graph.
- Resolve direct imports, aliases, default exports, and barrel re-exports.
- Name the nearest rendered component supported by evidence.
- Include the complete import chain in JSON and HTML while keeping the terminal summary concise.
- Report the unresolved segment when a chain cannot be completed.

## Priority 2: Confidence and coverage

Every conclusion should communicate how strongly Crust can support it.

### Evidence levels

- **Verified:** confirmed by emitted build artifacts and source analysis.
- **Inferred:** supported by source relationships but not directly confirmed by an emitted artifact.
- **Unknown:** Crust does not have enough evidence and refuses to guess.

### Suggested summary

```text
Analysis confidence: 92%
25/25 routes classified
8/8 emitted shells measured
94% of client JavaScript attributed
16 unresolved component relationships
```

Confidence must be derived from measurable coverage, not an arbitrary score. Keep the underlying counts available in JSON.

## Priority 3: Shared-cause blast radius

Find problems introduced by shared layouts, providers, client boundaries, and barrel files. Report one root cause with all affected routes instead of repeating the same finding per route.

```text
Shared regression
<RootProvider> adds 84 kB to 19 routes
Introduced by: @repo/features/analytics
```

### Useful groupings

- Shared layout or template
- Client provider or boundary
- Workspace package
- Barrel import
- Shared chunk
- Dynamic API or uncached service call

## Priority 4: Function-level dynamic tracing

Module-level taint is intentionally conservative, but it can blame imports a route never calls.

```ts
import { cachedProduct, liveProduct } from './services'
```

If a route calls only `cachedProduct`, it should not inherit taint from `liveProduct` merely because both functions live in the same module.

### Work required

- Track imported bindings to their exported declarations.
- Build a lightweight function call graph for first-party code.
- Propagate dynamic taint through called functions rather than entire modules when resolvable.
- Fall back to conservative module-level taint when calls are computed or otherwise opaque.
- Surface the fallback as inferred evidence.

## Priority 5: `crust init` — implemented

A guided setup command:

```bash
crust init [--cwd <dir>] [--ci github|gitlab|circleci|none] [--force] [--dry-run]
```

- [x] Analyze the current production build.
- [x] Create the first compatible snapshot.
- [x] Generate `.perf/budgets.json` with explained starter values.
- [x] Check source-map and Next.js configuration.
- [x] Offer CI configuration for the detected provider.
- [x] Explain which regression rules require no thresholds.

Generated budgets must be reviewable. Crust should never silently convert the current build into an unquestionable standard. In practice that meant three rules: every number states its derivation in the file itself, a number crust *chose* rather than measured says so, and a threshold with nothing to derive it from is left out with the reason rather than filled in with a default.

## Priority 6: Exceptional CI output

CI should answer whether the change can merge and show only blocking evidence by default.

```text
Merge verdict: fail

1 blocking regression
/courses/[slug] became dynamic
Cause: uncached fetch at packages/core/src/services/index.ts:29
Introduced by: <CoursePage>
Owner: packages/core
Suggested fix: cache _GetCourseData or isolate request-specific work
```

### Integrations

- GitHub source-line annotations
- SARIF output
- CODEOWNERS-aware ownership
- Acknowledged regressions with a reason and expiry date
- Stable check identifiers for updating existing comments
- No regression failure when the comparison or cause is ambiguous

## Priority 7: Configuration-change detection

Separate framework and build-configuration changes from application-source regressions.

Track changes to:

- `cacheComponents`
- Bundler
- Next.js major and relevant experimental flags
- Source-map emission and attribution coverage
- Route `dynamic`, `revalidate`, `runtime`, and `fetchCache` configuration
- Node versus Edge runtime
- Build environment values that materially affect output

Configuration changes should explain why snapshots are incomparable or why rendering behavior moved.

## Priority 8: Page-weight composition

Expand beyond client JavaScript only where the data strengthens build causality.

Potential additions:

- RSC/Flight payload size
- CSS loaded per route
- Fonts loaded per route
- Duplicated client modules
- Server Action payloads
- Layout-level client-boundary cost

Browser timing and network simulation should remain in `crust synthetic`, with each result clearly separated from build-time evidence.

## Priority 9: Exploratory HTML report

Keep `crust analyze` concise and make the HTML report the place for exploration.

The report should support:

- Selecting two compatible builds
- Filtering to regressions or improvements
- Expanding complete cause and import chains
- Grouping by layout, package, or shared cause
- Searching routes, components, and source files
- Showing every route affected by a shared import
- Copying a concise PR-ready explanation

## Priority 10: Compatibility fixtures

Crust's value depends on correctness across real Next.js output. Maintain production-build fixtures covering:

- Next.js 15 and 16
- Webpack and Turbopack
- Cache Components enabled and disabled
- Static routes, dynamic routes, ISR, PPR, and route handlers
- Dynamic params, catch-all params, and optional catch-all params
- Monorepos, path aliases, workspace packages, and barrel exports
- Flat and indexed source maps
- Node and Edge runtimes

Each supported combination should pin route classification, shell discovery, source attribution, and cause relationships.

## Recommended milestones

### Milestone 1: Trust — implemented

- [x] Complete cause chains
- [x] Confidence and coverage metrics
- [x] Function-level taint foundations
- [x] Compatibility fixtures for supported Next.js and bundler combinations

### Milestone 2: Leverage — mostly implemented

- [x] Shared-cause blast radius
- [x] Barrel and client-boundary cost attribution
- [x] Configuration-change detection (analyze; explicit diff/CI presentation remains)
- [x] Exploratory report filters

### Milestone 3: Adoption — started

- [x] `crust init`
- Source-line CI annotations
- SARIF and CODEOWNERS support
- Acknowledged regressions with expiry

### Milestone 4: Broader composition

- RSC payloads
- Route CSS and fonts
- Duplicate client modules
- Server Action and layout-boundary costs

## What not to build yet

- A second copy of the Next.js route table
- Generic chunk visualization as the primary workflow
- A composite performance score detached from source evidence
- An always-on hosted dashboard before local evidence is reliable
- AI-generated fixes presented without deterministic evidence
- More visual polish that does not improve causality, confidence, or actionability

## Success criteria

Crust is succeeding when a developer can answer these questions without manually inspecting build artifacts:

1. Why is this route dynamic?
2. Which component, function, or import caused it?
3. What left the static shell?
4. Which source files contribute the most client JavaScript?
5. What changed since the previous compatible build?
6. Is the current build better or worse?
7. Which other routes share the same root cause?
8. Does the evidence justify failing CI?
