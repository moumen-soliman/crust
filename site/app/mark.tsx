/**
 * The mark, inline so it inherits `currentColor` and never flashes on load.
 * Geometry is identical to docs/logo/*.svg — a solid crust laid over the body
 * it covers, breaking clean on three corners.
 */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M26 5v5H6V5h20Z" />
      <path d="M26 12.5V27H13a7 7 0 0 1-7-7V12.5h20Z" />
    </svg>
  )
}
