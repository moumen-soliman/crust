# One-command branch compare

Record two production builds from git tips, then run the existing checkout-free
`crust diff`. **CLI orchestration only** — not a full UI product.

## User command

```bash
crust diff develop chore/crust-ci --build
```

Optional:

```bash
crust diff develop chore/crust-ci --build 'pnpm --filter web build'
crust diff develop chore/crust-ci --build --parallel
crust diff develop chore/crust-ci --build --cwd apps/web
```

## Flow

1. **Parse** — `crust diff <base> <head> --build [cmd]`
2. **Resolve** — `git rev-parse` both refs; refuse unknown or same SHA
3. **Worktrees** — detached worktrees at each tip; never switch user `HEAD`
4. **Build** — run build cmd in each worktree app cwd (sequential or `--parallel`)
5. **Analyze** — `crust analyze --cwd <project>` with dist from the worktree → one `.perf/`
6. **Diff** — existing `loadPair` + terminal lead; no new renderer
7. **Cleanup** — remove worktrees; keep snapshots for the next checkout-free diff

## Surfaces

| Layer | Need | What |
| --- | --- | --- |
| CLI | Required | Flag + orchestration + progress + errors |
| Terminal UI | Reuse | Existing decision / CHANGES / CAUSES — no new views |
| HTML report | Out of scope | Two-build report stays Milestone 2 backlog |
| Web / PR UI | Do not build | No branch picker, dashboard, or hosted compare |

## Code map

| Path | Change |
| --- | --- |
| `src/cli.ts` | Add `--build [cmd]`, `--parallel`; wire before `loadPair` when both refs are named |
| `src/compare/build-pair.ts` (new) | Worktree create → build → analyze with dist override → cleanup; return `{ baseId, headId }` |
| `src/analyze/analyze.ts` | Ensure `--dist-dir` outside cwd works; snapshots still write to the project store root |
| `src/store/store.ts` | No resolve change; two-ref path already uses exact tip SHAs |
| `test/compare-build.test.ts` (new) | Unit: mock git/worktree; integration: fixture pair via `--build next build` |
| `docs/reference/cli.mdx` + quickstart | One recipe: `crust diff develop feature --build` |

## Flags

| Flag | Default | Note |
| --- | --- | --- |
| `--build [cmd]` | off / `next build` if bare | Only when both positionals are present |
| `--parallel` | `false` | Two worktrees building at once; more disk/CPU |
| `--cwd` | `pwd` | App / monorepo package root (store + analyze target) |
| `--dist-dir` | `.next` | Relative to each worktree app path |
| `--keep-worktrees` | `false` | Debug only |

## Acceptance gates

| Gate | Pass when |
| --- | --- |
| CLI only | No new React/web surface for compare |
| No checkout of user HEAD | Worktrees only; user branch untouched |
| One store | Both analyzes write to the same project `.perf/` |
| Reuse diff contract | Same lead + exit codes as `crust diff A B` |
| Fail loud | Build/analyze failure names which ref; no silent empty CLEAR |

## Phases

### P0 — Happy path

Two refs + `--build`; sequential worktrees; analyze into shared `.perf/`; existing
diff output; cleanup on success or fail.

### P1 — Hardening

Skip rebuild if tip SHA already has a comparable snapshot; `--parallel`; monorepo
`--cwd`; clear errors (dirty worktree, build fail, schema mismatch).

### P2 — Polish

Progress lines; init/docs mention; optional cache of worktree dirs under
`.perf/worktrees`.

### Defer — Not this feature

HTML UI, TanStack, hosted service, auto-detect turborepo filter graph.
Measuring Instant Navigations is unrelated — do not fold into this work.

## Done when

From a dirty working tree on an unrelated branch, one command builds both named
tips, writes two snapshots, prints the same diff as today, leaves `HEAD`
untouched, and exits non-zero only for real build / analyze / diff failures.
