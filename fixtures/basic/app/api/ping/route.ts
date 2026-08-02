// A Node route handler: no client bundle, no shell, no rendering mode. Pinned
// because reporting it as `unknown` implies a gap in the analysis when there is
// nothing there to analyse, and adding the app-wide chunks to it reports an API
// endpoint as shipping several hundred kB to a browser that never loads any.
export async function GET() {
  return Response.json({ ok: true, runtime: 'nodejs' })
}
