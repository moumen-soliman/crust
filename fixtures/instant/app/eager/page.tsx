// `prefetch` is the second half of the pair, and `'unstable_eager'` is the value
// that must survive as itself: folding it into `true` would report no change on a
// flip that gives every `<Link>` an implied `prefetch={true}`.
export const prefetch = 'unstable_eager'

export default function Page() {
  return <main>eagerly prefetched</main>
}
