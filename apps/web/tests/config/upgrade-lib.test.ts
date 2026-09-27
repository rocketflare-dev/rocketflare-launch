/**
 * `pnpm plugin upgrade`'s pure half (`scripts/lib/upgrade-lib.mjs`): the diff translator, the
 * release-note parser and the vendored-plugin predicate. The `config` project — no database, no
 * network.
 *
 * The translator is the risky part. It rewrites a plugin's diff into Launch's names before
 * anything is applied, and it is only safe because of two properties asserted below: a
 * substitution moves columns and never lines (so `@@` headers stay valid), and `index` lines are
 * stripped (so `git apply --3way` cannot silently merge against a preimage that no longer
 * describes anything).
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveNames } from '../../../../scripts/lib/rename-lib.mjs'
import {
  BinaryPatchError,
  compareVersions,
  countLines,
  isKitManifest,
  isVendored,
  parseNote,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from '../../../../scripts/lib/upgrade-lib.mjs'

const names = deriveNames('acme', 'Acme Logistics', { domain: 'acme.io' })

describe('the manifest predicate', () => {
  it('says the kit is the kit and an app is not', () => {
    const base = { $purpose: '', surfaces: [] }
    expect(isKitManifest({ ...base, app: null })).toBe(true)
    expect(
      isKitManifest({ ...base, app: { slug: 'acme', display: 'Acme', domain: 'acme.io' } })
    ).toBe(false)
    expect(isKitManifest(null)).toBe(false)
  })
})

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.15.0', '0.13.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.13.0')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })
})

const PATCH = `diff --git a/apps/web/src/api/index.ts b/apps/web/src/api/index.ts
index 1234abc..5678def 100644
--- a/apps/web/src/api/index.ts
+++ b/apps/web/src/api/index.ts
@@ -1,4 +1,4 @@ export function createApp(rocketflare: string) {
 import { thing } from '@rocketflare/shared/errors'
-const name = 'rocketflare-web'
+const name = 'rocketflare-worker'
 export const ROCKETFLARE_KEY = 'rocketflare_'
diff --git a/LICENSE b/LICENSE
index aaa..bbb 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1,2 +1,2 @@
-Copyright Rocketflare
+Copyright Rocketflare Ltd
`

describe('isVendored', () => {
  // ONE implementation, in this file, re-exported by plugin-lib.
  const KIT_REPO = 'https://github.com/rocketflare-dev/rocketflare.git'

  it('is the same answer from either module', async () => {
    const { isVendored: fromPluginLib } = await import('../../../../scripts/lib/plugin-lib.mjs')
    expect(fromPluginLib).toBe(isVendored)
  })

  it('normalises a trailing slash and a missing .git, and refuses a subdirectory', () => {
    expect(isVendored({ repo: KIT_REPO, subdir: '' }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: 'https://github.com/rocketflare-dev/rocketflare' }, KIT_REPO)).toBe(
      true
    )
    expect(isVendored({ repo: `${KIT_REPO}/` }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO, subdir: 'plugins/x' }, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: 'https://github.com/acme/p.git' }, KIT_REPO)).toBe(false)
    expect(isVendored(null, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: '' }, KIT_REPO)).toBe(false)
  })
})

describe('splitDiff', () => {
  it('splits on the file header and keeps each block whole', () => {
    const blocks = splitDiff(PATCH)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].header).toContain('apps/web/src/api/index.ts')
    expect(blocks[1].header).toContain('LICENSE')
    expect(blocks[0].raw).toContain('@@ -1,4 +1,4 @@')
  })

  it('is empty for an empty diff', () => {
    expect(splitDiff('')).toEqual([])
  })
})

describe('translateBlock', () => {
  const [source, license] = splitDiff(PATCH)

  it('rewrites the body into the app’s names', () => {
    const t = translateBlock(source, names)
    expect(t).toContain("from '@acme/shared/errors'")
    expect(t).toContain("-const name = 'acme-web'")
    expect(t).toContain("+const name = 'acme-worker'")
    expect(t).toContain('ACME_KEY')
    expect(t).toContain("'acme_'")
    expect(t).not.toContain('rocketflare')
  })

  it('leaves the hunk header counts byte-identical', () => {
    const t = translateBlock(source, names)
    expect(t).toContain('@@ -1,4 +1,4 @@')
    // Against the STRIPPED original: dropping `index` lines is the only length change allowed.
    expect(countLines(stripIndexLines(source.raw))).toBe(countLines(t))
  })

  it('strips the index lines so --3way cannot silently misbehave', () => {
    expect(source.raw).toMatch(/^index /m)
    expect(translateBlock(source, names)).not.toMatch(/^index /m)
  })

  it('translates the path lines even when the body is left alone', () => {
    const t = translateBlock(license, names, { translate: false })
    expect(t).toContain('-Copyright Rocketflare')
    expect(t).toContain('+Copyright Rocketflare Ltd')
    expect(countLines(stripIndexLines(license.raw))).toBe(countLines(t))
  })

  it('refuses a binary block rather than corrupting base85', () => {
    const binary = splitDiff(
      `diff --git a/logo.png b/logo.png
index a..b 100644
GIT binary patch
literal 12
zcmZQ
`
    )[0]
    expect(() => translateBlock(binary, names)).toThrow(BinaryPatchError)
  })
})

describe('parseNote', () => {
  it('reads scalars, booleans, lists and a literal null', () => {
    const note = parseNote(`---
version: 0.5.0
previous: null
breaking: true
migrations: ["a budget column"]
areas: [api, ui]
---

## What changed
body
`)
    expect(note?.data).toMatchObject({
      version: '0.5.0',
      previous: null,
      breaking: true,
      migrations: ['a budget column'],
      areas: ['api', 'ui'],
    })
    expect(note?.body).toContain('## What changed')
  })

  it('reads a block sequence, which is how three long migrations are written', () => {
    const note = parseNote(`---
version: 0.6.0
migrations:
  - "conversations gains a rolling summary"
  - "messages gains nullable provider and model columns"
areas: [api]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'conversations gains a rolling summary',
      'messages gains nullable provider and model columns',
    ])
    expect(note?.data.areas).toEqual(['api'])
  })

  it('keeps a comma inside a quoted item instead of splitting on it', () => {
    // A migrations entry is a human sentence, and sentences contain commas. Splitting on every
    // one turns a description into fragments — a corrupted note rather than a rejected one.
    const note = parseNote(`---
migrations: ["group types, groups and membership, and a visibility column", "a second one"]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'group types, groups and membership, and a visibility column',
      'a second one',
    ])
  })

  it('reads an empty key as null, not as an empty list', () => {
    const note = parseNote(`---
previous:
areas: [api]
---

## What changed
`)
    expect(note?.data.previous).toBeNull()
  })

  it('is null without frontmatter', () => {
    expect(parseNote('# just a heading\n')).toBeNull()
  })
})

/**
 * `mirror().isAncestor` — the predicate behind `pnpm plugin upgrade`'s "this diff runs BACKWARDS"
 * warning.
 *
 * The failure it guards against is not a crash: with an untagged branch head as `--from`,
 * `latestTag()` picks an OLDER release as `--to` and the report says "deleted 22 file(s)",
 * listing whole subsystems. Exercised against this repository's own history, which always has at
 * least two commits.
 */
describe('mirror().isAncestor', () => {
  it('knows which way round two commits are', async () => {
    const { mirror } = await import('../../../../scripts/lib/git-lib.mjs')
    const repo = mirror(path.resolve(__dirname, '../../../..'))
    expect(repo.isAncestor('HEAD~1', 'HEAD')).toBe(true)
    expect(repo.isAncestor('HEAD', 'HEAD~1')).toBe(false)
    // A commit is its own ancestor.
    expect(repo.isAncestor('HEAD', 'HEAD')).toBe(true)
  })
})
