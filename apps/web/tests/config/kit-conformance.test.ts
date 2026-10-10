/**
 * The static kit conformance check (D36 §7, `services/launch/kits/conformance.ts`), pure over a
 * file map. The passing kit is Rocketflare as it ships — its tomls (`fixtures/rocketflare-0.15`,
 * the same shape as 0.17.8's), its CI (`fixtures/kit-ci`) and its deploy workflow
 * (`fixtures/kit-deploy/0.17.8-deploy.yml`, verbatim) — read through the built-in fallback
 * manifest; each failing case breaks one requirement and expects one sentence naming it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkKitConformance,
  initScriptPath,
  releaseWorkflowProblems,
  workflowCheckNames,
  yamlOutline,
} from '@/api/services/launch/kits/conformance'
import { rocketflareFallbackManifest } from '@/api/services/launch/kits/rocketflare-fallback'

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')

const ROCKETFLARE: Record<string, string> = {
  '.rocketflare.json': JSON.stringify({
    kit: { name: 'rocketflare', version: '0.17.8' },
    app: null,
  }),
  'scripts/rename.mjs': '// the rename\n',
  'CLAUDE.md': '# Rocketflare\n',
  '.github/workflows/ci.yml': fixture('kit-ci/0.16.0-ci.yml'),
  '.github/workflows/deploy.yml': fixture('kit-deploy/0.17.8-deploy.yml'),
  'apps/web/wrangler.toml': fixture('rocketflare-0.15/wrangler.toml'),
  'apps/web/wrangler.staging.toml': fixture('rocketflare-0.15/wrangler.staging.toml'),
}

const reader =
  (files: Record<string, string | null>) =>
  async (path: string): Promise<string | null> =>
    files[path] ?? null

async function check(overrides: Record<string, string | null> = {}) {
  return checkKitConformance(reader({ ...ROCKETFLARE, ...overrides }))
}

describe('a conforming kit', () => {
  it('Rocketflare as it ships passes through the fallback manifest', async () => {
    const result = await check()
    expect(result.problems).toEqual([])
    expect(result).toMatchObject({ ok: true, manifestSource: 'fallback' })
    expect(result.manifest).toEqual(rocketflareFallbackManifest())
  })

  it('a kit of its own, with AGENTS.md instead of CLAUDE.md and its own names, passes', async () => {
    const manifest = rocketflareFallbackManifest()
    const own = {
      ...manifest,
      kit: { ...manifest.kit, id: 'acme-kit', name: 'Acme kit' },
      scaffold: { ...manifest.scaffold, init: 'node scripts/init.mjs {slug} {display} {domain}' },
    }
    const rename = (t: string) => t.replaceAll('rocketflare', 'acmekit')
    const result = await check({
      'launch.kit.json': JSON.stringify(own),
      '.rocketflare.json': null,
      'scripts/rename.mjs': null,
      'scripts/init.mjs': '// init\n',
      'CLAUDE.md': null,
      'AGENTS.md': '# Acme\n',
      'apps/web/wrangler.toml': rename(ROCKETFLARE['apps/web/wrangler.toml'] as string),
      'apps/web/wrangler.staging.toml': rename(
        ROCKETFLARE['apps/web/wrangler.staging.toml'] as string
      ),
    })
    expect(result.problems).toEqual([])
    expect(result).toMatchObject({ ok: true, manifestSource: 'repo' })
  })
})

describe('the meta-kit (rocketflare-dev/launch-kit 0.1.0)', () => {
  /** Its launch.kit.json, workflows and tomls verbatim (`fixtures/launch-kit-0.1/`, commit 6774861). */
  const META: Record<string, string> = {
    'launch.kit.json': fixture('launch-kit-0.1/launch.kit.json'),
    '.github/workflows/ci.yml': fixture('launch-kit-0.1/.github/workflows/ci.yml'),
    '.github/workflows/deploy.yml': fixture('launch-kit-0.1/.github/workflows/deploy.yml'),
    'apps/web/wrangler.toml': fixture('launch-kit-0.1/apps/web/wrangler.toml'),
    'apps/web/wrangler.staging.toml': fixture('launch-kit-0.1/apps/web/wrangler.staging.toml'),
    'scripts/init.mjs': '// init\n',
    'CLAUDE.md': '# Launch Kit\n',
  }

  it('passes Launch’s static check, as it passes its own kit-check.mjs', async () => {
    const result = await checkKitConformance(reader(META))
    expect(result.problems).toEqual([])
    expect(result).toMatchObject({ ok: true, manifestSource: 'repo' })
    expect(result.manifest?.kit).toMatchObject({
      id: 'launch-kit',
      repo: 'https://github.com/rocketflare-dev/launch-kit.git',
    })
  })

  it('fails when its dispatch input stops offering production', async () => {
    const deploy = (META['.github/workflows/deploy.yml'] as string).replace(
      /options: \[staging, production\]/,
      'options: [staging]'
    )
    const result = await checkKitConformance(
      reader({ ...META, '.github/workflows/deploy.yml': deploy })
    )
    expect(result.problems).toEqual([
      ".github/workflows/deploy.yml's `environment` input does not offer production",
    ])
  })
})

describe('what fails, one sentence each', () => {
  it('no manifest at all', async () => {
    const result = await check({ '.rocketflare.json': null })
    expect(result).toMatchObject({ ok: false, manifest: null })
    expect(result.problems).toEqual([
      "No launch.kit.json at the kit's root, and it is not a Rocketflare release Launch knows",
    ])
  })

  it('missing files', async () => {
    const result = await check({
      'scripts/rename.mjs': null,
      'CLAUDE.md': null,
      '.github/workflows/ci.yml': null,
      '.github/workflows/deploy.yml': null,
      'apps/web/wrangler.staging.toml': null,
    })
    expect(result.problems).toEqual([
      'The init script scripts/rename.mjs is missing',
      'There is no CLAUDE.md or AGENTS.md telling session agents how to work in the kit',
      '.github/workflows/ci.yml is missing',
      '.github/workflows/deploy.yml is missing',
      'apps/web/wrangler.staging.toml is missing',
    ])
  })

  it('a ci.yml that never runs on pull requests', async () => {
    const ci = (ROCKETFLARE['.github/workflows/ci.yml'] as string).replace(
      /^ {2}pull_request:\n/m,
      ''
    )
    const result = await check({ '.github/workflows/ci.yml': ci })
    expect(result.problems).toEqual([
      '.github/workflows/ci.yml does not run on `pull_request` (where the required check reports)',
    ])
  })

  it('a ci.yml without the required check', async () => {
    const ci = (ROCKETFLARE['.github/workflows/ci.yml'] as string).replace(
      'name: Gate',
      'name: Tests'
    )
    const result = await check({ '.github/workflows/ci.yml': ci })
    expect(result.problems).toEqual([
      '.github/workflows/ci.yml has no job named Gate (the required check); its jobs are Tests',
    ])
  })

  it('a release workflow without the protocol triggers or the OIDC permission', async () => {
    const yml = [
      'name: Deploy',
      'on:',
      '  push:',
      '    branches: [main]',
      '  workflow_dispatch:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    # id-token: write would go here',
    ].join('\n')
    expect(releaseWorkflowProblems(yml, 'deploy.yml', 'environment')).toEqual([
      'deploy.yml is not triggered by pushing a version tag (`on.push.tags`)',
      'deploy.yml is not triggered by a published release (`on.release.types: [published]`)',
      "deploy.yml's `workflow_dispatch` has no `environment` input",
      'deploy.yml never requests `id-token: write` (the deployer authenticates with it)',
    ])
    expect(releaseWorkflowProblems('name: x\n', 'deploy.yml', 'environment')).toEqual([
      'deploy.yml has no `on:` block (triggers)',
    ])
  })

  it('tomls with a real id, an unprovisionable binding, a stray name and different shapes', async () => {
    const prod = (ROCKETFLARE['apps/web/wrangler.toml'] as string)
      .replace(/id = "<[A-Z0-9_]+>"/, 'id = "0123456789abcdef0123456789abcdef"')
      .concat('\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "y"\n')
      .replace('bucket_name = "rocketflare-files"', 'bucket_name = "shared-files"')
    const staging = (ROCKETFLARE['apps/web/wrangler.staging.toml'] as string).replace(
      'binding = "FILES"',
      'binding = "UPLOADS"'
    )
    const result = await check({
      'apps/web/wrangler.toml': prod,
      'apps/web/wrangler.staging.toml': staging,
    })
    expect(result.problems).toEqual([
      'apps/web/wrangler.toml declares what Launch cannot provision: d1_databases',
      'apps/web/wrangler.toml: the RATE_LIMIT_KV KV namespace id is a real id, not a <PLACEHOLDER> Launch fills',
      'apps/web/wrangler.toml: shared-files does not follow the naming rule rocketflare-<suffix>',
      'The two tomls bind different r2_buckets: FILES in production, UPLOADS in staging',
    ])
  })

  it('a staging toml that is not the production one plus the staging suffix', async () => {
    const staging = (ROCKETFLARE['apps/web/wrangler.staging.toml'] as string).replace(
      'queue = "rocketflare-jobs-staging"',
      'queue = "rocketflare-jobs"'
    )
    const result = await check({ 'apps/web/wrangler.staging.toml': staging })
    expect(result.problems).toEqual([
      'apps/web/wrangler.staging.toml: rocketflare-jobs does not follow the naming rule rocketflare-<suffix>-staging',
    ])
  })

  it('a toml that is not TOML', async () => {
    const result = await check({ 'apps/web/wrangler.toml': 'name = [' })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/^apps\/web\/wrangler\.toml does not parse: /)
  })
})

describe('the YAML outline', () => {
  it('reads keys by indentation, items, flow lists, quoted keys, block scalars and comments', () => {
    const text = [
      '"on": # the triggers',
      '  release:',
      '    types: [published, "edited"]',
      '  push:',
      '    tags:',
      "      - '[0-9]+.[0-9]+.[0-9]+' # a version",
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Not a job name',
      '        run: |',
      '          name: inside a block scalar',
      '    name: Build it',
      '  test:',
      '    runs-on: ubuntu-latest',
    ].join('\n')
    const doc = yamlOutline(text)
    expect(doc.map(n => n.key)).toEqual(['on', 'jobs'])
    const tags = doc[0]?.children[1]?.children[0]
    expect(tags?.children.map(c => c.value)).toEqual(['[0-9]+.[0-9]+.[0-9]+'])
    // A job's check name is its own `name:` (never a step's, never a block scalar's), else its id.
    expect(workflowCheckNames(text)).toEqual(['Build it', 'test'])
  })

  it('names the script a node init runs', () => {
    expect(initScriptPath('node scripts/rename.mjs {slug} {display}')).toBe('scripts/rename.mjs')
    expect(initScriptPath('pnpm init:app {slug}')).toBeNull()
  })
})
