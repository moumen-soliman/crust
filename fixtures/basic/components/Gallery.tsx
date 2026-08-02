'use client'

import Image from 'next/image'
import { Counter } from './Counter'

export function Gallery({ images }: { images: string[] }) {
  return (
    <div>
      {images.map((src) => (
        <Image key={src} src={src} alt="" width={320} height={240} />
      ))}
      <Counter />
    </div>
  )
}
