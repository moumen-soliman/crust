import { Suspense } from 'react'
import { Hero, Gallery } from '@/components'
import { getProduct } from '@/lib/product'

export function generateStaticParams() {
  return [{ slug: 'alpha' }, { slug: 'beta' }]
}

// Shell engine target: <Hero> should be predicted static,
// <Gallery> sits under a Suspense boundary fed by an uncached fetch.
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return (
    <main>
      <Hero title={`Product ${slug}`} />
      <Suspense fallback={<p id="gallery-fallback">Loading gallery…</p>}>
        <ProductGallery slug={slug} />
      </Suspense>
    </main>
  )
}

async function ProductGallery({ slug }: { slug: string }) {
  const product = await getProduct(slug)
  return <Gallery images={product.images} />
}
