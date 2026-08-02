// Catch-all params. The prerender manifest lists the concrete paths and the
// route table lists the pattern, so this pins that the two are matched by
// `srcRoute` rather than by prefix - which is what once reported every route in
// a real app as partially static.
export function generateStaticParams() {
  return [{ slug: ['guide'] }, { slug: ['guide', 'install'] }]
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  return (
    <main>
      <h1>Docs</h1>
      <p>{slug.join(' / ')}</p>
    </main>
  )
}
