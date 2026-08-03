import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { VERSION } from '../src/version.ts'

/**
 * The version is inlined by a build-time `define`, which is exactly the kind of
 * wiring that breaks quietly: a missing define does not fail the build, it just
 * stamps every snapshot with the wrong `toolVersion` and makes history read as
 * if it came from a tool that never shipped.
 */
describe('tool version', () => {
  it('comes from package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('is a resolved string rather than an un-substituted placeholder', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
