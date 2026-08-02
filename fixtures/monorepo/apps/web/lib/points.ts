export async function loadPoints(): Promise<number[]> {
  const res = await fetch('https://example.invalid/points', { cache: 'no-store' })
  if (!res.ok) return [1, 2, 3]
  return (await res.json()) as number[]
}
