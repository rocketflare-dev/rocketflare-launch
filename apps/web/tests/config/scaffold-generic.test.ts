/**
 * The GENERIC scaffold job (D36 K3), EXECUTED with Node for a kit that is not Rocketflare: the
 * meta-kit `rocketflare-dev/launch-kit` 0.1.0, whose real `launch.kit.json` is the fixture
 * (`tests/fixtures/launch-kit-0.1/`). Its `scripts/init.mjs` is a stand-in that records its argv
 * and does what an init does (renames the tomls, records the app); `pnpm` is a stub on PATH that
 * records every argv and answers `gate --list --json` behind a package manager's header line.
 *
 * What it proves: the job runs the kit's OWN commands from the manifest Launch embedded (init with
 * shell-quoted values, postInit, the default plugins through `plugins.add`, the gate's lint and
 * typecheck through `ci.gateList` / `ci.gateRun`), deletes the `kitOnly` globs, stamps the app
 * manifest with `kit {id, version, commit}`, and runs NONE of the Rocketflare-legacy steps; a
 * private kit's read token reaches git only through env and is revoked; and the identity checks
 * (the plan's kit, the kit at the pin, init's app block, the gate's steps) stop it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  SCAFFOLD_SCRIPT_PATH,
  SCAFFOLD_WORKFLOW_PATH,
  scaffoldFiles,
  scaffoldJobKit,
  scaffoldScript,
} from '@/api/services/launch/scaffold/job'

const FIXTURE = path.resolve(__dirname, '../fixtures/launch-kit-0.1')
const MANIFEST_TEXT = readFileSync(path.join(FIXTURE, 'launch.kit.json'), 'utf8')
const META_KIT: KitManifest = parseKitManifest(MANIFEST_TEXT)
const PUSH_TOKEN = 'ghs_genericPushToken0123456789'
const KIT_TOKEN = 'ghs_genericKitReadToken987654321'
const TAG = '0.1.0'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

function write(root: string, rel: string, content: string) {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/**
 * The meta-kit's init, cut down: records argv, refuses without --force, renames the kit's
 * tokens in the tomls and records the app in `.launch-app.json` (no kit block: the job stamps it).
 * `STUB_INIT_SLUG` makes it record another slug, `STUB_INIT_SKIP_MANIFEST` makes it write none.
 */
const INIT_STUB = `import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync('.init-argv.json', JSON.stringify(args))
if (!args.includes('--force')) process.exit(2)
const [slug, display] = args
const domain = args[args.indexOf('--domain') + 1]
for (const file of ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']) {
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replaceAll('launch-kit.dev', domain).replaceAll('Launch Kit', display).replaceAll('launch-kit', slug))
}
if (!process.env.STUB_INIT_SKIP_MANIFEST) {
  const app = { slug: process.env.STUB_INIT_SLUG || slug, display, domain }
  writeFileSync('.launch-app.json', JSON.stringify({ app }, null, 2) + '\\n')
}
console.log('initialised as ' + slug)
`

/** pnpm: records argv; `gate --list --json` prints a header line, then the list (GATE_LIST). */
const PNPM_STUB = `#!/bin/sh
echo "$*" >> "$PNPM_LOG"
if [ "$1" = "gate" ] && [ "$2" = "--list" ]; then
  echo "> launch-kit@0.1.0 gate /work/app"
  echo "> node scripts/gate.mjs --list --json"
  echo ""
  if [ -n "$GATE_LIST" ]; then echo "$GATE_LIST"; else
  echo '{"schema":1,"steps":[{"id":"lint","title":"Lint"},{"id":"typecheck","title":"Types"},{"id":"test","title":"Tests"}]}'
  fi
fi
exit 0
`

const KIT_ONLY_FILES = [
  '.github/workflows/kit.yml',
  'FORKING.md',
  'docs/upgrades/0.1.0.md',
  'scripts/tests/kit-only/conformance.test.mjs',
]

interface Recorded {
  method: string
  url: string
  authorization: string | undefined
}

let root: string
let server: Server
let baseUrl: string
let kitSha: string
let otherKitSha: string
const calls: Recorded[] = []

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'launch-scaffold-generic-'))
  const kit = path.join(root, 'kit-src')
  mkdirSync(kit)
  git(kit, 'init', '--quiet', '-b', 'main')
  write(kit, 'launch.kit.json', MANIFEST_TEXT)
  write(kit, 'package.json', `${JSON.stringify({ name: 'launch-kit', version: TAG }, null, 2)}\n`)
  for (const env of ['wrangler.toml', 'wrangler.staging.toml']) {
    write(kit, `apps/web/${env}`, readFileSync(path.join(FIXTURE, 'apps/web', env), 'utf8'))
  }
  write(
    kit,
    '.github/workflows/ci.yml',
    readFileSync(path.join(FIXTURE, '.github/workflows/ci.yml'), 'utf8')
  )
  write(kit, 'scripts/init.mjs', INIT_STUB)
  write(kit, 'CLAUDE.md', '# Launch Kit\n')
  write(kit, 'docs/README.md', 'Kept: only docs/upgrades/** is kit-only.\n')
  // Files a Rocketflare-legacy step would touch, were it (wrongly) to run on this kit.
  write(kit, 'apps/web/tests/config/plugin-ci.test.ts', '// not a Rocketflare copy\n')
  for (const f of KIT_ONLY_FILES) write(kit, f, '# kit only\n')
  git(kit, 'add', '-A')
  git(kit, 'commit', '--quiet', '-m', `Release ${TAG}`)
  git(kit, 'tag', '-a', TAG, '-m', TAG)
  kitSha = git(kit, 'rev-parse', 'HEAD')
  // The same repo at a commit whose launch.kit.json is ANOTHER kit: the job must refuse it.
  git(kit, 'checkout', '--quiet', '-b', 'other-kit')
  write(kit, 'launch.kit.json', MANIFEST_TEXT.replace('"id": "launch-kit"', '"id": "acme-kit"'))
  git(kit, 'commit', '--quiet', '-am', 'Another kit')
  otherKitSha = git(kit, 'rev-parse', 'HEAD')
  git(kit, 'checkout', '--quiet', 'main')
  mkdirSync(path.join(root, 'server/acme'), { recursive: true })
  git(root, 'clone', '--quiet', '--bare', kit, 'server/acme/launch-kit.git')

  // GitHub's DELETE /installation/token, for the revocations.
  server = createServer((req, res) => {
    calls.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    })
    res.writeHead(req.method === 'DELETE' ? 204 : 404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

let appRepo: string
let initialSha: string

beforeEach(() => {
  calls.length = 0
  const bare = path.join(root, 'server/acme/shop.git')
  rmSync(bare, { recursive: true, force: true })
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
  const seed = mkdtempSync(path.join(root, 'seed-'))
  git(seed, 'init', '--quiet', '-b', 'main')
  write(seed, 'README.md', '# shop\n')
  for (const f of scaffoldFiles(META_KIT)) write(seed, f.path, f.content ?? '')
  git(seed, 'add', '-A')
  git(seed, 'commit', '--quiet', '-m', 'Initial commit')
  git(seed, 'push', '--quiet', bare, 'main')
  initialSha = git(seed, 'rev-parse', 'HEAD')
  appRepo = bare
})

function plan(over: Record<string, unknown> = {}) {
  return {
    slug: 'shop',
    displayName: "Bob's Shop & Co",
    domain: 'clewro.com',
    repo: 'acme/shop',
    kitRepo: 'acme/launch-kit',
    kitId: 'launch-kit',
    tag: TAG,
    commit: kitSha,
    ...over,
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  pnpm: string[]
}

/** The script generated for `manifest`, run as the sandbox would (--token-from-env). */
function runScript(
  opts: {
    manifest?: KitManifest
    plan?: Record<string, unknown>
    args?: string[]
    env?: Record<string, string>
  } = {}
): Promise<RunResult> {
  const scriptFile = path.join(root, 'scaffold.mjs')
  writeFileSync(scriptFile, scaffoldScript(opts.manifest ?? META_KIT))
  const workdir = mkdtempSync(path.join(root, 'work-'))
  const bin = mkdtempSync(path.join(root, 'bin-'))
  const log = path.join(bin, 'pnpm.log')
  writeFileSync(log, '')
  write(bin, 'pnpm', PNPM_STUB)
  chmodSync(path.join(bin, 'pnpm'), 0o755)
  return new Promise(resolve => {
    const child = spawn(
      'node',
      [scriptFile, '--token-from-env', '--workdir', workdir, ...(opts.args ?? [])],
      {
        cwd: root,
        env: {
          ...GIT_ENV,
          GITHUB_ACTIONS: '',
          GITHUB_SERVER_URL: `file://${path.join(root, 'server')}`,
          GITHUB_API_URL: `${baseUrl}/github`,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          PNPM_LOG: log,
          LAUNCH_SCAFFOLD_TOKEN: PUSH_TOKEN,
          LAUNCH_SCAFFOLD_KIT_TOKEN: KIT_TOKEN,
          LAUNCH_SCAFFOLD_PLAN: JSON.stringify(plan(opts.plan)),
          ...opts.env,
        },
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => {
      stdout += d
    })
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('close', code =>
      resolve({
        code,
        stdout,
        stderr,
        pnpm: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
      })
    )
  })
}

function pushed() {
  const clone = mkdtempSync(path.join(root, 'check-'))
  git(root, 'clone', '--quiet', appRepo, clone)
  return {
    dir: clone,
    head: git(clone, 'rev-parse', 'HEAD'),
    files: git(clone, 'ls-files').split('\n'),
    read: (rel: string) => readFileSync(path.join(clone, rel), 'utf8'),
  }
}

describe('the script Launch generates from a kit manifest', () => {
  it('embeds the kit’s commands, kit-only globs, app manifest and gate — nothing Rocketflare', () => {
    const kit = scaffoldJobKit(META_KIT)
    expect(kit).toEqual({
      id: 'launch-kit',
      name: 'Launch Kit',
      version: { file: 'package.json', field: 'version' },
      init: 'node scripts/init.mjs {slug} {display} --domain {domain} --force --skip-install',
      kitOnly: [
        '.github/workflows/kit.yml',
        'FORKING.md',
        'docs/upgrades/**',
        'scripts/tests/kit-only/**',
      ],
      postInit: ['pnpm install --no-frozen-lockfile', 'pnpm lint:fix'],
      appManifest: '.launch-app.json',
      gateList: 'pnpm gate --list --json',
      gateRun: 'pnpm gate {step}',
      plugins: null,
    })
    const script = scaffoldScript(META_KIT)
    expect(script).toContain(`const KIT = ${JSON.stringify(kit, null, 2)}`)
    expect(script).toContain('const LAUNCH_ENDPOINT = "/ci/scaffold"')
    expect(scaffoldScript(META_KIT, { endpoint: '/ci/kit-check' })).toContain(
      'const LAUNCH_ENDPOINT = "/ci/kit-check"'
    )
    // The script is a pure function of the manifest: a retry commits nothing new.
    expect(scaffoldScript(parseKitManifest(MANIFEST_TEXT))).toBe(script)
    expect(scaffoldFiles(META_KIT).map(f => f.path)).toEqual([
      SCAFFOLD_WORKFLOW_PATH,
      SCAFFOLD_SCRIPT_PATH,
    ])
  })
})

describe('a meta-kit app, scaffolded', () => {
  it('runs init (values shell-quoted), postInit and the gate from the manifest; stamps the app manifest', async () => {
    const run = await runScript()
    expect(run.code, run.stderr).toBe(0)
    const repo = pushed()

    // One commit on top of Launch's, named after the kit.
    expect(git(repo.dir, 'rev-parse', 'HEAD~1')).toBe(initialSha)
    expect(git(repo.dir, 'log', '-1', '--format=%s')).toBe(`Start from Launch Kit ${TAG}`)
    expect(git(repo.dir, 'log', '-1', '--format=%b')).toContain(kitSha)

    // init received each value as ONE argument, quote and ampersand intact.
    expect(JSON.parse(repo.read('.init-argv.json'))).toEqual([
      'shop',
      "Bob's Shop & Co",
      '--domain',
      'clewro.com',
      '--force',
      '--skip-install',
    ])
    expect(repo.read('apps/web/wrangler.toml')).toContain('name = "shop"')
    expect(repo.read('apps/web/wrangler.staging.toml')).toContain('name = "shop-staging"')

    // postInit, then the gate: the list (behind pnpm's header lines), lint, typecheck — and only
    // those (no Rocketflare `web test:config`, no full gate).
    expect(run.pnpm).toEqual([
      'install --no-frozen-lockfile',
      'lint:fix',
      'gate --list --json',
      'gate lint',
      'gate typecheck',
    ])

    // kitOnly gone; everything else kept; the job's own files gone.
    for (const gone of [
      ...KIT_ONLY_FILES,
      SCAFFOLD_SCRIPT_PATH,
      SCAFFOLD_WORKFLOW_PATH,
      'README.md',
    ]) {
      expect(repo.files, gone).not.toContain(gone)
    }
    expect(repo.files).toEqual(
      expect.arrayContaining([
        'docs/README.md',
        'launch.kit.json',
        'CLAUDE.md',
        '.github/workflows/ci.yml',
      ])
    )

    // The app manifest: init's app block, the job's kit block.
    expect(JSON.parse(repo.read('.launch-app.json'))).toEqual({
      app: { slug: 'shop', display: "Bob's Shop & Co", domain: 'clewro.com' },
      kit: { commit: kitSha, version: TAG, id: 'launch-kit' },
    })
  })

  it('runs none of the Rocketflare-legacy steps', async () => {
    const run = await runScript()
    expect(run.code, run.stderr).toBe(0)
    const repo = pushed()
    expect(run.stdout).not.toMatch(
      /rocketflare#37|legacy steps apply|KIT\.preserved|default-plugins/
    )
    expect(
      run.pnpm.some(a => a.startsWith('web ') || a.startsWith('plugin ') || a.startsWith('db:'))
    ).toBe(false)
    // A legacy step would delete this (issue 5) — on a kit that is not Rocketflare it stays.
    expect(repo.files).toContain('apps/web/tests/config/plugin-ci.test.ts')
    expect(repo.files).not.toContain('scripts/lib/rename-lib.mjs')
  })

  it('installs the kit’s default plugins through plugins.add, when it declares them', async () => {
    const withPlugins = parseKitManifest(
      JSON.stringify({
        ...JSON.parse(MANIFEST_TEXT),
        plugins: {
          defaults: [
            {
              id: 'audit',
              repo: 'https://github.com/acme/kit-plugins.git',
              ref: '1.2.0',
              subdir: 'plugins/audit',
            },
            { id: 'flags', repo: 'https://github.com/acme/flags.git', ref: '0.3.0' },
          ],
          add: 'pnpm plugin add {repo}@{ref} --subdir {subdir} --id {id}',
        },
      })
    )
    const run = await runScript({ manifest: withPlugins })
    expect(run.code, run.stderr).toBe(0)
    expect(run.pnpm.filter(a => a.startsWith('plugin '))).toEqual([
      'plugin add https://github.com/acme/kit-plugins.git@1.2.0 --subdir plugins/audit --id audit',
      'plugin add https://github.com/acme/flags.git@0.3.0 --subdir  --id flags',
    ])
    // After postInit, before the gate.
    expect(run.pnpm.indexOf('lint:fix')).toBeLessThan(
      run.pnpm.findIndex(a => a.startsWith('plugin '))
    )
    expect(run.pnpm.findIndex(a => a.startsWith('plugin '))).toBeLessThan(
      run.pnpm.indexOf('gate --list --json')
    )
  })

  it('--skip-install skips postInit and the plugins, not the gate', async () => {
    const run = await runScript({ args: ['--skip-install'] })
    expect(run.code, run.stderr).toBe(0)
    expect(run.pnpm).toEqual(['gate --list --json', 'gate lint', 'gate typecheck'])
  })

  it('a private kit: the kit read token reaches git through env only, is never printed, and is revoked', async () => {
    const run = await runScript()
    expect(run.code, run.stderr).toBe(0)
    const revoked = calls.filter(c => c.method === 'DELETE').map(c => c.authorization)
    expect(revoked).toEqual([`Bearer ${PUSH_TOKEN}`, `Bearer ${KIT_TOKEN}`])
    const basic = Buffer.from(`x-access-token:${KIT_TOKEN}`).toString('base64')
    for (const output of [run.stdout, run.stderr]) {
      expect(output).not.toContain(KIT_TOKEN)
      expect(output).not.toContain(basic)
    }
    expect(run.stdout).toContain('read with a kit token')
  })
})

describe('what stops the generic job', () => {
  it('a plan for another kit (the job files on main are stale)', async () => {
    const run = await runScript({ plan: { kitId: 'rocketflare' } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      'The plan is for kit rocketflare, but this job was generated for kit launch-kit'
    )
    expect(pushed().head).toBe(initialSha)
  })

  it('a kit at the pin whose launch.kit.json is another kit', async () => {
    const run = await runScript({ plan: { tag: null, commit: otherKitSha } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      'The kit at the pin is acme-kit (its launch.kit.json), but this job was generated for launch-kit'
    )
    expect(pushed().head).toBe(initialSha)
  })

  it('an init that records another app, or none', async () => {
    const other = await runScript({ env: { STUB_INIT_SLUG: 'someone-else' } })
    expect(other.code).toBe(1)
    expect(other.stderr).toContain(
      '.launch-app.json names the app someone-else after scaffold.init, not shop'
    )
    const none = await runScript({ env: { STUB_INIT_SKIP_MANIFEST: '1' } })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('scaffold.init did not write .launch-app.json')
    expect(pushed().head).toBe(initialSha)
  })

  it('a gate with no typecheck step, or no list at all', async () => {
    const noTypes = await runScript({
      env: { GATE_LIST: '{"schema":1,"steps":[{"id":"lint"},{"id":"test"}]}' },
    })
    expect(noTypes.code).toBe(1)
    expect(noTypes.stderr).toContain('The kit gate has no typecheck step (it lists lint, test)')
    const noList = await runScript({ env: { GATE_LIST: 'nothing to see' } })
    expect(noList.code).toBe(1)
    expect(noList.stderr).toContain('did not print a gate list (schema 1)')
    expect(pushed().head).toBe(initialSha)
  })

  it('a failing init: its exit code, named by its command', async () => {
    const run = await runScript({
      manifest: parseKitManifest(MANIFEST_TEXT.replace('--force --skip-install', '--skip-install')),
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('node scripts/init.mjs failed (exit 2)')
    expect(pushed().head).toBe(initialSha)
  })
})
