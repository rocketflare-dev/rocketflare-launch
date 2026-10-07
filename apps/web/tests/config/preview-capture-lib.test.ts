/**
 * The preview camera's library is served from a generated string
 * (`src/api/preview/capture-lib.generated.ts`, `scripts/preview-capture-lib.mjs`): it must be the
 * installed `modern-screenshot`'s browser build, byte for byte, so a package bump cannot ship an
 * old library.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPTURE_LIB_SOURCE, CAPTURE_LIB_VERSION } from '@/api/preview/capture-lib.generated'

const web = join(__dirname, '../..')
const require = createRequire(join(web, 'package.json'))
const pkgDir = dirname(require.resolve('modern-screenshot/package.json'))

describe('the preview capture library', () => {
  it('is the installed modern-screenshot browser build', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    expect(CAPTURE_LIB_VERSION).toBe(pkg.version)
    expect(CAPTURE_LIB_SOURCE).toBe(readFileSync(join(pkgDir, 'dist/index.js'), 'utf8'))
  })

  it('is what the generator writes (node scripts/preview-capture-lib.mjs --check)', () => {
    expect(() =>
      execFileSync('node', [join(web, '../../scripts/preview-capture-lib.mjs'), '--check'], {
        stdio: 'pipe',
      })
    ).not.toThrow()
  })
})
