import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readActualShell } from '../src/shell/verify.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('shell artifact discovery', () => {
  it('finds concrete shells for dynamic params at multiple path depths', async () => {
    const dist = await fixture({
      '[locale]/courses/[slug].html': '',
      'en/courses/intro.html': '<body>Course shell</body>',
    })

    const shell = await readActualShell(dist, '/[locale]/courses/[slug]')

    expect(shell?.htmlPath).toBe('server/app/en/courses/intro.html')
    expect(shell?.shellRatio).toBe(1)
  })

  it('matches catch-all and optional catch-all outputs', async () => {
    const dist = await fixture({
      'docs/a/getting-started.html': '<body>Docs</body>',
      'shop.html': '<body>Shop</body>',
    })

    expect((await readActualShell(dist, '/docs/[...parts]'))?.htmlPath)
      .toBe('server/app/docs/a/getting-started.html')
    expect((await readActualShell(dist, '/shop/[[...parts]]'))?.htmlPath)
      .toBe('server/app/shop.html')
  })
})

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crust-shell-'))
  roots.push(root)
  const app = join(root, 'server', 'app')
  for (const [file, contents] of Object.entries(files)) {
    const path = join(app, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }
  return root
}
