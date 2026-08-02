# Resolved open questions

The plan (§12) left these open. Building answered them.

## Name

`crust`. Both `husk` and `crust` are taken on npm — `husk` is an active-ish package last touched
in 2022, `crust` an empty placeholder from 2023 — so first publish is scoped (`@<handle>/crust`)
with the binary still named `crust`, per the plan's fallback. No `next-*` name, per Vercel's
trademark guidance.

## Adapter `onBuildComplete` — not needed

Phase 3 was planned against the adapter hook. Phase 0 showed the prerendered shell HTML is written
to `.next/server/app/**` unconditionally, with the fallback UI sitting in each hole and boundary
ids in document order. The shell engine reads files; no deployment adapter, no shim, no
undocumented API. `postponedState` was never parsed (zero `.postponed` files were even emitted).

## Turbopack stats — source maps only, and that is fine

There is no webpack-stats equivalent, but Turbopack's client-reference manifests are genuinely
route-scoped (webpack's are global) and its source maps attribute **99.8%** of bytes versus
webpack's 87.1%. Attribution on Turbopack is source-maps-only and *better*. The stamping
transform (R4) remains unbuilt on both bundlers; nothing in phases 1–7 needed it.

## Pages Router — detect-and-warn

Hybrid apps get their `app/` routes analysed with a warning that `pages/` is invisible to every
number. Pages-only apps get a refusal naming the non-goal, not a crash.

## CI on forks — same-repo pushes only

A fork PR's `GITHUB_TOKEN` is read-only on the base repository. The action posts the comment for
fork PRs but skips the `perf-history` push; `crust history push` itself reports and exits cleanly
when the push is rejected. Diffs still work from whatever snapshots the branch already has.

## Budget format — all three axes

`.perf/budgets.json` accepts absolute bytes (`firstLoadBytes`, `defaultFirstLoadBytes`),
percentage growth versus the baseline (`maxGrowth`), and shell ratio floors (`minShellRatio`,
`defaultMinShellRatio`). They answer different questions — "too big", "grew too fast", and
"stopped being static" — and a check that enforces only bytes passes a PR that halves the shell.

## Phase 1 exit criterion — restated

"Totals within 5% of `next build` output" died when Next 16.2 removed size columns from the build
output. The replacement: **first-load bytes must equal the sum of on-disk sizes of the route's
chunks plus shared root chunks**, which is what the analyzer computes and what the e2e fixtures
pin. Accuracy of *attribution* (which source produced the bytes) is tracked separately by the
spike's whole-build percentages: 87.1% webpack / 99.8% Turbopack.

## SQLite index — `node:sqlite`, not better-sqlite3

The plan named `better-sqlite3`; it is a native module and a version-conflict magnet. Node's
built-in `node:sqlite` keeps the dependency count at zero. On runtimes without it, every reader
falls back to scanning the per-file store — the index is an optimisation, never a capability.
