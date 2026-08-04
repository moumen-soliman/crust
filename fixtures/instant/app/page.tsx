// The control: no navigation segment config at all, so its recorded config must
// stay empty. A route that acquires an `instant` or `prefetch` key here means the
// reader started inferring one.
export default function Page() {
  return <main>home</main>
}
