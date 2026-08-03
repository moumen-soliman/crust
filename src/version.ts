/**
 * The one place the tool version is read from.
 *
 * `package.json` is the source; tsup and vitest both inline it through
 * `__CRUST_VERSION__` at build/transform time, so there is no runtime file read
 * and no second copy to forget. This matters more than it looks: `toolVersion`
 * is written into every snapshot, and a stale constant here would silently
 * mislabel the history that diffs are computed against.
 */
declare const __CRUST_VERSION__: string

export const VERSION: string = __CRUST_VERSION__
