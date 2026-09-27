/**
 * `SCAFFOLD_SCRIPT` (Launch P2, slice 2b), EXECUTED with Node — the job a new app's repo runs once.
 * No GitHub and no network: a fixture "kit" repo (a stub `scripts/rename.mjs` that records its
 * argv and renames by the patched `KIT.preserved`, the kit's real `.rocketflare.json` and tomls)
 * and the new app's repo are bare repositories under a `file://` "server" (`GITHUB_SERVER_URL`),
 * and one local HTTP server stands in for Launch (`/ci/scaffold/token|done`), the Actions OIDC
 * token endpoint and GitHub's `DELETE /installation/token`.
 *
 * Every run is `--skip-install --skip-gate` (no pnpm); the real kit 0.15.0 end to end, gate and
 * all, is the real-infrastructure exit's (plan §5.4).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  SCAFFOLD_SCRIPT,
  SCAFFOLD_SCRIPT_PATH,
  SCAFFOLD_WORKFLOW_PATH,
  SCAFFOLD_WORKFLOW_YAML,
  scaffoldFiles,
} from '@/api/services/launch/rocketflare/scaffold-job'

const FIXTURES = path.resolve(__dirname, '../fixtures/rocketflare-0.15')
const KIT_COMMIT_TAG = '0.15.0'
const PUSH_TOKEN = 'ghs_scaffoldTestToken0123456789'
const OIDC_TOKEN = 'oidc.jwt.value-for-launch'

/** git with no user/global config in the way (signing, hooks, default branch). */
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

/** The kit's `scripts/lib/rename-lib.mjs`, cut down to the part the scaffold patches and reads. */
const RENAME_LIB = `export const KIT = Object.freeze({
  slug: 'rocketflare',
  preserved: [
    'github.com/rocketflare-dev/rocketflare',
    '.rocketflare.local.json',
    'rocketflare-plugin.json',
    '.rocketflare.json',
  ],
})
`

/**
 * A stand-in for the kit's rename: records its argv, exits with STUB_RENAME_EXIT when set, and
 * otherwise renames every listed text file the way the real one does — the preserved literals
 * held back, then \`rocketflare\` → slug — and stamps the manifest's app block.
 */
const RENAME_STUB = `import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { KIT } from './lib/rename-lib.mjs'
const args = process.argv.slice(2)
writeFileSync('.rename-argv.json', JSON.stringify(args))
if (process.env.STUB_RENAME_EXIT) process.exit(Number(process.env.STUB_RENAME_EXIT))
const [slug, display] = args
const domain = args[args.indexOf('--domain') + 1]
for (const file of ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml', 'apps/web/docker-compose.dev.yml', 'docs/PLUGINS.md', '.github/workflows/ci.yml']) {
  if (!existsSync(file)) continue
  let text = readFileSync(file, 'utf8')
  KIT.preserved.forEach((literal, i) => { text = text.split(literal).join('\\u0000' + i + '\\u0000') })
  text = text.replaceAll('rocketflare.dev', domain).replaceAll('Rocketflare', display).replaceAll('rocketflare', slug)
  KIT.preserved.forEach((literal, i) => { text = text.split('\\u0000' + i + '\\u0000').join(literal) })
  writeFileSync(file, text)
}
const manifest = JSON.parse(readFileSync('.rocketflare.json', 'utf8'))
manifest.app = { slug, display, domain }
writeFileSync('.rocketflare.json', JSON.stringify(manifest, null, 2) + '\\n')
console.log('renamed to ' + slug)
`

interface Recorded {
  method: string
  url: string
  authorization: string | undefined
  body: unknown
}

let root: string
let server: Server
let baseUrl: string
let kitSha: string
const calls: Recorded[] = []
let tokenPlan: Record<string, unknown>
let tokenStatus = 200

function plan(over: Record<string, unknown> = {}) {
  return {
    slug: 'shop',
    displayName: 'Shop',
    domain: 'clewro.com',
    repo: 'acme/shop',
    kitRepo: 'rocketflare-dev/rocketflare',
    tag: KIT_COMMIT_TAG,
    commit: kitSha,
    ...over,
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'launch-scaffold-test-'))

  // ---- the kit, tagged
  const kit = path.join(root, 'kit-src')
  mkdirSync(kit)
  git(kit, 'init', '--quiet', '-b', 'main')
  write(kit, '.rocketflare.json', readFileSync(path.join(FIXTURES, '.rocketflare.json'), 'utf8'))
  write(kit, 'apps/web/wrangler.toml', readFileSync(path.join(FIXTURES, 'wrangler.toml'), 'utf8'))
  write(
    kit,
    'apps/web/wrangler.staging.toml',
    readFileSync(path.join(FIXTURES, 'wrangler.staging.toml'), 'utf8')
  )
  write(kit, 'scripts/lib/rename-lib.mjs', RENAME_LIB)
  write(kit, 'scripts/rename.mjs', RENAME_STUB)
  write(
    kit,
    'apps/web/docker-compose.dev.yml',
    'services:\n  neon-proxy:\n    image: ghcr.io/rocketflare-dev/local-neon-proxy@sha256:abc\n'
  )
  write(
    kit,
    'docs/PLUGINS.md',
    'Install https://github.com/rocketflare-dev/rocketflare-plugins.git or rocketflare-dev/rocketflare-plugin-analytics; CI: rocketflare-dev/rocketflare/.github/workflows/plugin-ci.yml@main\n'
  )
  write(kit, '.github/workflows/ci.yml', 'name: CI\n# rocketflare\n')
  write(kit, '.github/workflows/notify-plugins.yml', 'name: Notify\n')
  write(kit, '.github/workflows/plugin-ci.yml', 'name: Plugin CI\n')
  write(kit, 'apps/web/tests/config/plugin-ci.test.ts', '// reads plugin-ci.yml\n')
  write(kit, 'CLAUDE.md', '# Rocketflare\n')
  symlinkSync('CLAUDE.md', path.join(kit, 'AGENTS.md'))
  write(kit, 'scripts/run.sh', '#!/bin/sh\necho run\n')
  chmodSync(path.join(kit, 'scripts/run.sh'), 0o755)
  git(kit, 'add', '-A')
  git(kit, 'commit', '--quiet', '-m', 'Release 0.15.0')
  git(kit, 'tag', '-a', KIT_COMMIT_TAG, '-m', KIT_COMMIT_TAG)
  kitSha = git(kit, 'rev-parse', 'HEAD')
  mkdirSync(path.join(root, 'server/rocketflare-dev'), { recursive: true })
  git(root, 'clone', '--quiet', '--bare', kit, 'server/rocketflare-dev/rocketflare.git')

  // ---- Launch, the Actions OIDC endpoint and GitHub's API, on one local server
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    calls.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    })
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(json === undefined ? '' : JSON.stringify(json))
    }
    if (req.url?.startsWith('/oidc')) return send(200, { value: OIDC_TOKEN })
    if (req.url === '/launch/ci/scaffold/token') {
      return tokenStatus === 200
        ? send(200, {
            ticketId: '00000000-0000-4000-8000-000000000001',
            token: PUSH_TOKEN,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            plan: tokenPlan,
          })
        : send(tokenStatus, { error: 'No scaffold is waiting', statusCode: tokenStatus })
    }
    if (req.url === '/launch/ci/scaffold/done') return send(200, { status: 'finished' })
    if (req.url === '/github/installation/token' && req.method === 'DELETE') return send(204)
    return send(404, { message: 'not here' })
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

/** A fresh empty-ish app repo (what Launch's `repo` step leaves: auto_init + the two files). */
beforeEach(() => {
  calls.length = 0
  tokenStatus = 200
  tokenPlan = plan()
  const bare = path.join(root, 'server/acme/shop.git')
  rmSync(bare, { recursive: true, force: true })
  mkdirSync(path.dirname(bare), { recursive: true })
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
  const seed = mkdtempSync(path.join(root, 'seed-'))
  git(seed, 'init', '--quiet', '-b', 'main')
  write(seed, 'README.md', '# shop\n')
  for (const f of scaffoldFiles()) write(seed, f.path, f.content ?? '')
  git(seed, 'add', '-A')
  git(seed, 'commit', '--quiet', '-m', 'Initial commit')
  git(seed, 'push', '--quiet', bare, 'main')
  initialSha = git(seed, 'rev-parse', 'HEAD')
  appRepo = bare
})

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run the script as the job would, asynchronously so the local server can answer it. */
function runScript(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const scriptFile = path.join(root, 'scaffold.mjs')
  writeFileSync(scriptFile, SCAFFOLD_SCRIPT)
  const workdir = mkdtempSync(path.join(root, 'work-'))
  return new Promise(resolve => {
    const child = spawn('node', [scriptFile, '--workdir', workdir, ...args], {
      cwd: root,
      env: {
        ...GIT_ENV,
        GITHUB_ACTIONS: '',
        GITHUB_SERVER_URL: `file://${path.join(root, 'server')}`,
        GITHUB_API_URL: `${baseUrl}/github`,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => {
      stdout += d
    })
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

const envMode = (over: Record<string, unknown> = {}) => ({
  LAUNCH_SCAFFOLD_TOKEN: PUSH_TOKEN,
  LAUNCH_SCAFFOLD_PLAN: JSON.stringify(plan(over)),
})

/** The pushed `main`: its files, and a reader. */
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

describe('the workflow file', () => {
  it('asks for an OIDC token, reads no secret and passes Launch’s URL through env', () => {
    expect(SCAFFOLD_WORKFLOW_YAML).toContain('id-token: write')
    expect(SCAFFOLD_WORKFLOW_YAML).toContain('contents: read')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
    expect(SCAFFOLD_WORKFLOW_YAML).toContain('LAUNCH_URL: ${{ inputs.launch_url }}')
    expect(SCAFFOLD_WORKFLOW_YAML).toContain(`run: node ${SCAFFOLD_SCRIPT_PATH}`)
    expect(SCAFFOLD_WORKFLOW_YAML).not.toMatch(/secrets\./)
    expect(scaffoldFiles().map(f => [f.path, f.mode ?? '100644'])).toEqual([
      [SCAFFOLD_WORKFLOW_PATH, '100644'],
      [SCAFFOLD_SCRIPT_PATH, '100755'],
    ])
  })

  it('the script parses, and answers --help and a bad flag', async () => {
    expect((await runScript(['--help'])).code).toBe(0)
    const bad = await runScript(['--nope'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('unknown option --nope')
  })
})

describe('the scaffold, --token-from-env --skip-install --skip-gate', () => {
  it('pushes the renamed kit onto main as one commit, with the job’s own files gone', async () => {
    const resultFile = path.join(root, 'result.json')
    const run = await runScript(
      ['--token-from-env', '--skip-install', '--skip-gate', '--result', resultFile],
      envMode()
    )
    expect(run.code, run.stderr).toBe(0)

    const repo = pushed()
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
      commit: repo.head,
      ticketId: null,
    })
    // One commit on top of what Launch committed — pushed, never forced.
    expect(git(repo.dir, 'rev-parse', 'HEAD~1')).toBe(initialSha)
    expect(git(repo.dir, 'log', '-1', '--format=%s')).toBe(
      `Start from Rocketflare ${KIT_COMMIT_TAG}`
    )
    expect(git(repo.dir, 'log', '-1', '--format=%an <%ae>')).toBe('Launch <launch@localhost>')
    expect(git(repo.dir, 'log', '-1', '--format=%b')).toContain(kitSha)

    // The job's own files and the kit-only workflows (with the test that reads one) are gone.
    for (const gone of [
      SCAFFOLD_SCRIPT_PATH,
      SCAFFOLD_WORKFLOW_PATH,
      '.github/workflows/notify-plugins.yml',
      '.github/workflows/plugin-ci.yml',
      'apps/web/tests/config/plugin-ci.test.ts',
      'README.md',
    ]) {
      expect(repo.files, gone).not.toContain(gone)
    }
    expect(repo.files).toContain('.github/workflows/ci.yml')

    // The rename ran once, non-interactively, with the plan's names.
    expect(JSON.parse(repo.read('.rename-argv.json'))).toEqual([
      'shop',
      'Shop',
      '--domain',
      'clewro.com',
      '--force',
      '--skip-install',
    ])
    expect(repo.read('apps/web/wrangler.staging.toml')).toContain('name = "shop-staging"')
    expect(repo.read('.github/workflows/ci.yml')).toContain('# shop')

    // The provenance: the pinned kit commit recorded, the app stamped.
    const manifest = JSON.parse(repo.read('.rocketflare.json'))
    expect(manifest.kit).toMatchObject({ version: '0.15.0', commit: kitSha })
    expect(manifest.app).toEqual({ slug: 'shop', display: 'Shop', domain: 'clewro.com' })

    // Symlinks and executable bits survive the copy.
    expect(git(repo.dir, 'ls-files', '-s', 'AGENTS.md')).toMatch(/^120000 /)
    expect(git(repo.dir, 'ls-files', '-s', 'scripts/run.sh')).toMatch(/^100755 /)
  })

  it('keeps every rocketflare-dev/ reference (rocketflare#37)', async () => {
    const run = await runScript(['--token-from-env', '--skip-install', '--skip-gate'], envMode())
    expect(run.code, run.stderr).toBe(0)
    const repo = pushed()
    expect(repo.read('apps/web/docker-compose.dev.yml')).toContain(
      'ghcr.io/rocketflare-dev/local-neon-proxy@sha256:abc'
    )
    const plugins = repo.read('docs/PLUGINS.md')
    expect(plugins).toContain('https://github.com/rocketflare-dev/rocketflare-plugins.git')
    expect(plugins).toContain('rocketflare-dev/rocketflare-plugin-analytics')
    expect(plugins).toContain('rocketflare-dev/rocketflare/.github/workflows/plugin-ci.yml@main')
    expect(plugins).not.toContain('shop-dev/')
    // The patched list is committed, longest first, so later translations keep them too.
    const lib = repo.read('scripts/lib/rename-lib.mjs')
    expect(lib.indexOf("'github.com/rocketflare-dev/rocketflare',")).toBeLessThan(
      lib.indexOf("'rocketflare-dev/rocketflare-plugins',")
    )
    expect(lib.indexOf("'rocketflare-dev/rocketflare/',")).toBeLessThan(
      lib.indexOf("'rocketflare-dev/',")
    )
  })

  it('revokes the push token, and never prints it', async () => {
    const run = await runScript(['--token-from-env', '--skip-install', '--skip-gate'], envMode())
    expect(run.code, run.stderr).toBe(0)
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: 'DELETE',
        url: '/github/installation/token',
        authorization: `Bearer ${PUSH_TOKEN}`,
      })
    )
    const basic = Buffer.from(`x-access-token:${PUSH_TOKEN}`).toString('base64')
    for (const output of [run.stdout, run.stderr]) {
      expect(output).not.toContain(PUSH_TOKEN)
      expect(output).not.toContain(basic)
    }
  })
})

describe('failures stop the scaffold with their exit code', () => {
  it('propagates the rename’s exit code, pushes nothing and still revokes', async () => {
    const run = await runScript(['--token-from-env', '--skip-install', '--skip-gate'], {
      ...envMode(),
      STUB_RENAME_EXIT: '2',
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('node scripts/rename.mjs failed (exit 2)')
    expect(pushed().head).toBe(initialSha)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })

  it('refuses a tag that no longer points at the pinned commit', async () => {
    const run = await runScript(
      ['--token-from-env', '--skip-install', '--skip-gate'],
      envMode({ commit: 'f'.repeat(40) })
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/not the pinned f{40}: refusing a moved tag/)
    expect(pushed().head).toBe(initialSha)
  })

  it('refuses an unusable plan before touching anything', async () => {
    const run = await runScript(
      ['--token-from-env', '--skip-install', '--skip-gate'],
      envMode({ slug: 'Bad Slug', repo: 'no-slash' })
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('slug must be')
    expect(run.stderr).toContain('repo must be owner/name')
    expect(calls).toEqual([])
  })

  it('--token-from-env without the token is a usage error', async () => {
    const run = await runScript(['--token-from-env', '--skip-install', '--skip-gate'], {
      LAUNCH_SCAFFOLD_PLAN: JSON.stringify(plan()),
    })
    expect(run.code).toBe(2)
  })
})

describe('in a GitHub job: the OIDC token buys the push token, and done is reported', () => {
  const actionsEnv = () => ({
    LAUNCH_URL: `${baseUrl}/launch/`,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${baseUrl}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token',
  })

  it('trades the OIDC token at /ci/scaffold/token, pushes, revokes, then calls /done', async () => {
    const run = await runScript(['--skip-install', '--skip-gate'], actionsEnv())
    expect(run.code, run.stderr).toBe(0)
    const repo = pushed()

    const oidc = calls.filter(c => c.url.startsWith('/oidc'))
    // One token for /token and a FRESH one for /done (a job's token lives minutes).
    expect(oidc).toHaveLength(2)
    for (const c of oidc) {
      expect(new URL(c.url, baseUrl).searchParams.get('audience')).toBe(`${baseUrl}/launch`)
      expect(c.authorization).toBe('Bearer runner-request-token')
    }
    const sequence = calls.filter(c => !c.url.startsWith('/oidc')).map(c => `${c.method} ${c.url}`)
    expect(sequence).toEqual([
      'POST /launch/ci/scaffold/token',
      'DELETE /github/installation/token',
      'POST /launch/ci/scaffold/done',
    ])
    const token = calls.find(c => c.url === '/launch/ci/scaffold/token')
    expect(token?.authorization).toBe(`Bearer ${OIDC_TOKEN}`)
    const done = calls.find(c => c.url === '/launch/ci/scaffold/done')
    expect(done?.body).toEqual({ commit: repo.head })
    expect(git(repo.dir, 'log', '-1', '--format=%ae')).toBe('launch@127.0.0.1')
    expect(run.stdout).not.toContain(PUSH_TOKEN)
    expect(run.stdout).not.toContain(OIDC_TOKEN)
  })

  it('stops when Launch refuses the token, with nothing pushed', async () => {
    tokenStatus = 409
    const run = await runScript(['--skip-install', '--skip-gate'], actionsEnv())
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Launch refused the scaffold token: HTTP 409')
    expect(pushed().head).toBe(initialSha)
    expect(calls.some(c => c.url.endsWith('/done'))).toBe(false)
  })

  it('needs an OIDC token to be available at all', async () => {
    const run = await runScript(['--skip-install', '--skip-gate'], {
      LAUNCH_URL: `${baseUrl}/launch`,
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('id-token: write')
    expect(pushed().head).toBe(initialSha)
  })
})
