import { fetchJson } from './http'

export type Product = { slug: string; images: string[] }

// Regression: the cache directive is gone, so this read is uncached again.
export async function getProduct(slug: string): Promise<Product> {
  const data = await fetchJson<Product>(`https://example.invalid/products/${slug}`)
  return data ?? { slug, images: ['/a.png', '/b.png'] }
}
