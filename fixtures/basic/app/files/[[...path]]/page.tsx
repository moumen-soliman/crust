// Optional catch-all: the pattern also matches `/files` with no segments at
// all, which is the shape route-file discovery is most likely to miss.
export function generateStaticParams() {
  return [{ path: [] }, { path: ['reports', '2026'] }]
}

export default async function FilesPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params
  return (
    <main>
      <h1>Files</h1>
      <p>{path?.length ? path.join('/') : 'root'}</p>
    </main>
  )
}
