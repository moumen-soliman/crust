// `instant` also accepts an options object, which is legal to Next and unreadable
// to a static literal reader. This is the case that must come out as *unknown*
// rather than as absent: recording nothing would be indistinguishable from a route
// that declares no instant contract, which is an inference this axis must never
// make. crust records no value and raises a route warning naming the key.
export const instant = { level: 'warning' as const }

export default function Page() {
  return <main>declares an instant contract crust cannot read</main>
}
