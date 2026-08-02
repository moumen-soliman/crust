// The Edge runtime emits a different manifest shape than Node does.
export const runtime = 'edge'

export async function GET() {
  return Response.json({ ok: true, runtime: 'edge' })
}
