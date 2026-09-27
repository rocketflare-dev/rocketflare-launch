/**
 * The kit-to-Launch translator (`scripts/lib/rename-lib.mjs`) that `pnpm plugin add|upgrade` runs
 * every plugin file through: name derivation and the ordered replacement classes. No database, no
 * filesystem — the `config` project. It asserts on the kit's own token strings on purpose.
 */
import { describe, expect, it } from 'vitest'
import {
  applyReplacements,
  CLASS_IDS,
  deriveNames,
  isBinary,
  KIT,
  validateSlug,
} from '../../../../scripts/lib/rename-lib.mjs'

describe('deriveNames', () => {
  it('derives snake, UPPER, display and the placeholder domain from a hyphenated slug', () => {
    expect(deriveNames('my-app')).toEqual({
      slug: 'my-app',
      snake: 'my_app',
      upper: 'MY_APP',
      display: 'My App',
      domain: 'my-app.example.com',
      prefix: 'my_app_',
      colour: null,
    })
  })

  it('takes an explicit display name, domain and colour', () => {
    const names = deriveNames('acme', 'ACME Corp', { domain: 'Acme.IO', colour: '#FF0000' })
    expect(names.display).toBe('ACME Corp')
    expect(names.domain).toBe('acme.io')
    expect(names.colour).toBe('#ff0000')
    expect(names.snake).toBe('acme')
    expect(names.upper).toBe('ACME')
  })

  it('rejects a bad domain or colour', () => {
    expect(() => deriveNames('acme', undefined, { domain: 'nodots' })).toThrow(/apex host/)
    expect(() => deriveNames('acme', undefined, { colour: 'red' })).toThrow(/6-digit hex/)
  })

  it('refuses a multi-line display name', () => {
    // `scripts/upgrade.mjs` translates kit diffs with these replacements, and its hunk headers
    // stay valid only because a substitution moves columns and never line counts.
    expect(() => deriveNames('acme', 'Acme\nCorp')).toThrow(/single line/)
    expect(() => deriveNames('acme', 'Acme\rCorp')).toThrow(/single line/)
  })
})

describe('validateSlug', () => {
  it('accepts lowercase slugs with digits and hyphens', () => {
    expect(validateSlug('acme')).toBeNull()
    expect(validateSlug('my-app2')).toBeNull()
  })

  it('refuses the kit name, uppercase, leading digits, underscores and a trailing hyphen', () => {
    expect(validateSlug(KIT.slug)).toMatch(/kit's own name/)
    expect(validateSlug('MyApp')).toMatch(/must match/)
    expect(validateSlug('1app')).toMatch(/must match/)
    expect(validateSlug('my_app')).toMatch(/must match/)
    expect(validateSlug('my-')).toMatch(/trailing|end with a hyphen/)
    expect(validateSlug('')).toMatch(/required/)
  })
})

/** One paragraph with every token class the kit ships. */
const SAMPLE = [
  'import { x } from "@rocketflare/shared/ai/config" // @rocketflare/web',
  "ROCKETFLARE_API_KEY=… ROCKETFLARE_URL=… ENV_PREFIX = 'ROCKETFLARE'",
  "~/.rocketflare/config.json and CONFIG_DIR_NAME = '.rocketflare' and $HOME/.rocketflare",
  'noreply@rocketflare.dev app.rocketflare.dev staging.rocketflare.dev admin@rocketflare.local',
  'postgresql://rocketflare:rocketflare_pass@localhost:5432/rocketflare_dev',
  'POSTGRES_USER: rocketflare',
  'pg_isready -U rocketflare -d rocketflare_dev',
  'rocketflare_app rocketflare_test rocketflare_ab12cd34',
  'rocketflare-agent-run-staging rocketflare-jobs rocketflare-files-staging rocketflare-light',
  'APP_NAME=Rocketflare Test <title>Rocketflare</title>',
  'name = "rocketflare" bin rocketflare, cfld.name rocketflare; container rocketflare-dev-postgres',
  'https://github.com/rocketflare-dev/rocketflare.git stays',
].join('\n')

describe('applyReplacements', () => {
  it('renames every class for a hyphenated slug without partial-form mismatches', () => {
    const names = deriveNames('my-app')
    const { text, counts, preserved } = applyReplacements(SAMPLE, names)
    expect(text).toBe(
      [
        'import { x } from "@my-app/shared/ai/config" // @my-app/web',
        "MY_APP_API_KEY=… MY_APP_URL=… ENV_PREFIX = 'MY_APP'",
        "~/.my-app/config.json and CONFIG_DIR_NAME = '.my-app' and $HOME/.my-app",
        'noreply@my-app.example.com app.my-app.example.com staging.my-app.example.com admin@my-app.example.com',
        'postgresql://my_app:my_app_pass@localhost:5432/my_app_dev',
        'POSTGRES_USER: my_app',
        'pg_isready -U my_app -d my_app_dev',
        'my_app_app my_app_test my_app_ab12cd34',
        'my-app-agent-run-staging my-app-jobs my-app-files-staging my-app-light',
        'APP_NAME=My App Test <title>My App</title>',
        'name = "my-app" bin my-app, cfld.name my-app; container my-app-dev-postgres',
        'https://github.com/rocketflare-dev/rocketflare.git stays',
      ].join('\n')
    )
    // The classic mismatches: scope/env must not pick up the hyphenated or snake forms.
    expect(text).not.toMatch(/my-app_|@my_app\/|MY-APP|my_app-|\.my_app\b/)
    expect(text).toContain('-staging')
    expect(preserved).toBe(1)
    expect(counts).toEqual({
      scope: 2,
      env: 3,
      domain: 4,
      cfgdir: 3,
      dbuser: 3,
      snake: 6,
      kebab: 5,
      display: 2,
      bare: 3,
    })
  })

  it('collapses every class to the same word for a single-word slug', () => {
    const { text } = applyReplacements(SAMPLE, deriveNames('acme', 'Acme Ops'))
    expect(text).toContain('@acme/shared')
    expect(text).toContain('ACME_API_KEY')
    expect(text).toContain('~/.acme/config.json')
    expect(text).toContain('noreply@acme.example.com')
    expect(text).toContain('postgresql://acme:acme_pass@localhost:5432/acme_dev')
    expect(text).toContain('acme_app')
    expect(text).toContain('acme-agent-run-staging')
    expect(text).toContain('APP_NAME=Acme Ops Test')
    expect(text.replaceAll(KIT.preserved[0], '')).not.toMatch(/[Rr]ocketflare/)
  })

  /**
   * The three filenames that keep the KIT's name in a renamed app. `.rocketflare.json` describes
   * the kit and is deliberately never renamed (D27); its sidecar follows it; and
   * `rocketflare-plugin.json` is the same in every plugin repository in the world (D31). Rewritten,
   * a copy renamed to `acme` looked for `.acme.json` and every `pnpm plugin` command died against a
   * file sitting in its root, `.gitignore` stopped ignoring the sidecar, and the app could never
   * install any plugin. They are preserved LONGEST FIRST, or `.rocketflare.json` would claim the
   * head of `.rocketflare.local.json` and leave `.local.json` behind for the domain class.
   */
  it('never rewrites the three filenames that name the kit on purpose', () => {
    const names = deriveNames('acme', 'Acme')
    const input = [
      'Provenance lives in `.rocketflare.json`, and `pnpm plugin` reads it.', // prose
      '.rocketflare.local.json', // a .gitignore line, alone on it
      'node_modules/', // its neighbour, untouched either way
      "export const MANIFEST_FILE = '.rocketflare.json'", // a JS string
      "if (!source.has('rocketflare-plugin.json')) stop(5)", // and the plugin manifest
      'but rocketflare-web and @rocketflare/shared still move', // …while everything else does
    ].join('\n')
    const { text, preserved } = applyReplacements(input, names)
    expect(text).toContain('`.rocketflare.json`')
    expect(text.split('\n')[1]).toBe('.rocketflare.local.json')
    expect(text).toContain("MANIFEST_FILE = '.rocketflare.json'")
    expect(text).toContain("source.has('rocketflare-plugin.json')")
    expect(text).toContain('acme-web and @acme/shared still move')
    expect(text).not.toMatch(/\.acme\.json|acme-plugin\.json|acme\.example\.com\.json/)
    expect(preserved).toBe(4)
  })

  it('keeps the upstream org, its repositories and its images under their real names', () => {
    const names = deriveNames('launch', 'Launch', { domain: 'clewro.com' })
    const input = [
      'image: ghcr.io/rocketflare-dev/local-neon-proxy@sha256:abc',
      'https://github.com/rocketflare-dev/rocketflare-plugins.git',
      'rocketflare-dev/rocketflare-plugin-analytics',
      "import { x } from '@rocketflare/shared/errors'",
    ].join('\n')
    expect(applyReplacements(input, names).text).toBe(
      [
        'image: ghcr.io/rocketflare-dev/local-neon-proxy@sha256:abc',
        'https://github.com/rocketflare-dev/rocketflare-plugins.git',
        'rocketflare-dev/rocketflare-plugin-analytics',
        "import { x } from '@launch/shared/errors'",
      ].join('\n')
    )
  })

  it('applies the classes longest-first: the env class takes the bare ENV_PREFIX too', () => {
    const { text, counts } = applyReplacements("'ROCKETFLARE' ROCKETFLARE_X", deriveNames('a-b'))
    expect(text).toBe("'A_B' A_B_X")
    expect(counts.env).toBe(2)
    expect(counts.bare).toBe(0)
  })

  it('keeps the domain ahead of the config-dir class (app.rocketflare.dev is not a config dir)', () => {
    const { text, counts } = applyReplacements('https://app.rocketflare.dev', deriveNames('a-b'))
    expect(text).toBe('https://app.a-b.example.com')
    expect(counts.cfgdir).toBe(0)
  })

  it('returns the identical string and zero counts when nothing matches', () => {
    const input = 'nothing to see here'
    const result = applyReplacements(input, deriveNames('acme'))
    expect(result.text).toBe(input)
    expect(result.total).toBe(0)
  })

  it('table columns are the class ids in application order', () => {
    expect(CLASS_IDS).toEqual([
      'scope',
      'env',
      'domain',
      'cfgdir',
      'dbuser',
      'snake',
      'kebab',
      'display',
      'bare',
    ])
  })
})

describe('binary detection', () => {
  it('spots a binary by a NUL byte in the head', () => {
    expect(isBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true)
    expect(isBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
  })
})
