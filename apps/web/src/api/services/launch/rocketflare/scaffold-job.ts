/**
 * The one-shot scaffold job (plan §1): the two files Launch commits into a new app's EMPTY repo
 * (`auto_init`) through the Git Data API before dispatching the job — the workflow
 * `.github/workflows/launch-scaffold.yml` and the script `.launch/scaffold.mjs` — as strings.
 *
 * The job runs in the new repo on a GitHub-hosted runner, because building the app needs what a
 * Worker cannot do: Node, `pnpm install`, the kit's own rename, plugin installer and Biome.
 *
 * `SCAFFOLD_SCRIPT` is plain Node ESM with no dependencies (Node ≥ 24). What it does, in order,
 * stopping at the first failure with that step's exit code (`set -e`):
 *
 *  1. **Get a push token and the plan.** In a GitHub job: request the job's OIDC token for the
 *     audience `LAUNCH_URL` and `POST $LAUNCH_URL/ci/scaffold/token` → a one-hour installation token
 *     scoped to this repo (`contents` + `workflows` write — `GITHUB_TOKEN` can never push a
 *     workflow file, and the rename rewrites them) and the plan. `--token-from-env` instead reads
 *     `LAUNCH_SCAFFOLD_TOKEN` and `LAUNCH_SCAFFOLD_PLAN` (JSON) — the P3 sandbox and the tests.
 *     The token is masked (`::add-mask::`), never an argv, never printed; git receives it as an
 *     `http.<server>/.extraheader` through `GIT_CONFIG_*` env on the app-repo commands only.
 *  2. Clone the app repo (its `main`) and the kit at the plan's tag, and **refuse unless the tag
 *     resolves to the pinned commit** — a moved tag is a different kit.
 *  3. Replace the app's tree with the kit's (history stays the app's), and record the kit commit
 *     in `.rocketflare.json` (what the kit's `install.sh` does).
 *  4. **Patch the rename's `KIT.preserved`** (rocketflare#37): without it the rename rewrites every
 *     `rocketflare-dev/` org reference (the neon-proxy image, the plugin repos, the reusable
 *     workflow). The patched list is imported back and checked, longest first.
 *  5. `node scripts/rename.mjs <slug> "<Display>" --domain <domain> --force` (its own `pnpm install`
 *     and `pnpm lint:fix`).
 *  6. Install the default plugins exactly as the kit's `gate.yml` does (`default-plugins.mjs
 *     --tsv` → `pnpm plugin add … --apply --allow-dirty` → `pnpm db:generate --name
 *     plugin-<id>-<version>`), then write their declarations (crons, `run_worker_first` prefixes,
 *     bindings, vars) into BOTH tomls with the kit's own `patch-toml` / `plugin-resources` — what
 *     `pnpm provision cloudflare <env>` would, so the app's deploy-time parity test
 *     (`REQUIRE_PROVISIONED=1`) finds them — the crons and prefixes by the script's own
 *     comment-aware append, because the kit's (0.15) counts a value quoted in a comment as present.
 *     Then `docs/plugin-api.md` regenerated and `pnpm install` so the lockfile matches.
 *  7. Delete the kit-only workflows (`notify-plugins.yml`, `plugin-ci.yml` and the config test
 *     that reads it), `.launch/` and the scaffold workflow itself, and apply the exact edits to
 *     kit 0.15 tests a renamed, provisioned copy fails through no fault of its own
 *     (`kitTestPatches` — an edit whose anchor is gone is skipped with a warning).
 *  8. Commit "Start from Rocketflare <tag>" as Launch (before the gate: kit tests read HEAD~1).
 *  9. The gate: `pnpm lint && pnpm typecheck && pnpm web test:config`; whatever it regenerated
 *     (`worker-configuration.d.ts`) is amended in. Push `main` (never forced).
 * 10. Revoke the token (`DELETE /installation/token`, always — on failure too) and, in a GitHub
 *     job, `POST $LAUNCH_URL/ci/scaffold/done { commit }` with a FRESH OIDC token (a job's token
 *     lives minutes; the scaffold takes longer).
 *
 * Flags: `--token-from-env`, `--skip-install` (no `pnpm`: the rename's install, the plugins and
 * the lockfile are skipped), `--skip-gate`, `--workdir <dir>` (kept afterwards), `--result
 * <file>` (writes `{ commit, ticketId }`). Env: `LAUNCH_URL`, `GITHUB_SERVER_URL` (clone and push
 * base, default `https://github.com`), `GITHUB_API_URL` (default `https://api.github.com`),
 * `LAUNCH_SCAFFOLD_AUTHOR_NAME` / `_EMAIL`. Exit 0 ok · 2 usage · otherwise the failing step's.
 *
 * `tests/config/scaffold-script.test.ts` executes it with Node against a fixture kit and a local
 * bare origin. The script is kept free of backticks and `${` so this file can hold it verbatim.
 */
import type { CommitFile } from '../github-app'

/** The workflow file's name — the `workflowFile` `/ci/scaffold` requires of the caller's token. */
export const SCAFFOLD_WORKFLOW_FILE = 'launch-scaffold.yml'
export const SCAFFOLD_WORKFLOW_PATH = `.github/workflows/${SCAFFOLD_WORKFLOW_FILE}`
export const SCAFFOLD_SCRIPT_PATH = '.launch/scaffold.mjs'

/** The kit's own workflows that make no sense in an app (they notify and test plugin repos). */
export const KIT_ONLY_WORKFLOWS = ['notify-plugins.yml', 'plugin-ci.yml'] as const

/**
 * rocketflare#37: the literals `scripts/lib/rename-lib.mjs`'s `KIT.preserved` gains, inserted after
 * `'github.com/rocketflare-dev/rocketflare'`, most specific first — `rocketflare-dev/` alone would
 * keep the org but still rename the repo after it (`rocketflare-plugins` → `<slug>-plugins`).
 */
export const PRESERVED_ORG_REFS = [
  'rocketflare-dev/rocketflare-plugins',
  'rocketflare-dev/rocketflare-plugin-',
  'rocketflare-dev/rocketflare/',
  'rocketflare-dev/',
] as const

/**
 * The workflow. Dispatched with `launch_url` (Launch's `APP_URL`), which is also the OIDC
 * audience; it reaches the script through `env`, never interpolated into a shell line.
 */
export const SCAFFOLD_WORKFLOW_YAML = [
  "# Launch's one-shot scaffold job. Launch committed this file and .launch/scaffold.mjs into the",
  '# new repository and dispatched it once; the commit the job pushes deletes both.',
  'name: Launch scaffold',
  '',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      launch_url:',
  "        description: Launch's origin (the OIDC audience the job authenticates to)",
  '        required: true',
  '        type: string',
  '',
  'permissions:',
  '  contents: read',
  '  id-token: write',
  '',
  'concurrency:',
  '  group: launch-scaffold',
  '  cancel-in-progress: false',
  '',
  'jobs:',
  '  scaffold:',
  '    name: Scaffold from the template',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 30',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with:',
  '          persist-credentials: false',
  '      - uses: actions/setup-node@v4',
  '        with:',
  '          node-version: 24',
  "      # pnpm comes from the kit's packageManager field, through corepack.",
  '      - run: corepack enable',
  '      - name: Scaffold',
  '        env:',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JS
  '          LAUNCH_URL: ${{ inputs.launch_url }}',
  "          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'",
  `        run: node ${SCAFFOLD_SCRIPT_PATH}`,
  '',
].join('\n')

/** The script. See the header for what it does; it is written without backticks or `${`. */
export const SCAFFOLD_SCRIPT = String.raw`#!/usr/bin/env node
// Launch's one-shot scaffold job: the pinned Rocketflare kit, renamed to this app, with its default
// plugins, gated, committed and pushed to main. Written by Launch; the commit it pushes deletes it.
//
//   node .launch/scaffold.mjs [--token-from-env] [--skip-install] [--skip-gate]
//                             [--workdir <dir>] [--result <file>]
//
// Exit 0 ok, 2 usage, otherwise the exit code of the step that failed. The push token is never
// printed and never passed on a command line.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USAGE = [
  'usage: node .launch/scaffold.mjs [--token-from-env] [--skip-install] [--skip-gate]',
  '                                 [--workdir <dir>] [--result <file>]',
  '',
  '  --token-from-env  read LAUNCH_SCAFFOLD_TOKEN (push token) and LAUNCH_SCAFFOLD_PLAN (JSON)',
  '                    instead of trading the GitHub Actions OIDC token at LAUNCH_URL',
  '  --skip-install    no pnpm: skip the install, the default plugins and the lockfile',
  '  --skip-gate       skip pnpm lint / typecheck / web test:config',
  '  --workdir <dir>   work there (and keep it) instead of a temporary directory',
  '  --result <file>   write { commit, ticketId } there when the push succeeded',
].join('\n')

const KIT_ONLY_WORKFLOWS = ['notify-plugins.yml', 'plugin-ci.yml']
// The test that reads plugin-ci.yml goes with it.
const KIT_ONLY_FILES = ['apps/web/tests/config/plugin-ci.test.ts']
const SCAFFOLD_WORKFLOW = '.github/workflows/launch-scaffold.yml'
const PRESERVE_ANCHOR = "'github.com/rocketflare-dev/rocketflare',"
const PRESERVE_EXTRA = [
  'rocketflare-dev/rocketflare-plugins',
  'rocketflare-dev/rocketflare-plugin-',
  'rocketflare-dev/rocketflare/',
  'rocketflare-dev/',
]
const TOMLS = { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' }

const inActions = process.env.GITHUB_ACTIONS === 'true'
const secrets = []

class StepError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.exitCode = exitCode || 1
  }
}

function redact(value) {
  let out = String(value)
  for (const s of secrets) if (s) out = out.split(s).join('***')
  return out
}
function log(line) {
  process.stdout.write(redact(line) + '\n')
}
function warn(line) {
  process.stderr.write(redact((inActions ? '::warning::' : 'warning: ') + line) + '\n')
}
function fail(message, exitCode) {
  throw new StepError(message, exitCode)
}
function addSecret(value) {
  if (!value) return
  secrets.push(value)
  if (inActions) process.stdout.write('::add-mask::' + value + '\n')
}

let openGroup = false
function step(title) {
  if (openGroup && inActions) process.stdout.write('::endgroup::\n')
  openGroup = true
  log(inActions ? '::group::' + title : '==> ' + title)
}

/** The environment a child sees: never the push token or the OIDC request credentials. */
function childEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.LAUNCH_SCAFFOLD_TOKEN
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL
  return { ...env, ...(extra || {}) }
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

/**
 * Run a command; a non-zero exit stops the scaffold with that exit code (set -e). With
 * capture the stdout is returned. With allowFail the status is returned instead of throwing.
 */
function run(cmd, args, opts) {
  const o = opts || {}
  if (!o.quiet) log('$ ' + [cmd].concat(args).map(quote).join(' '))
  const res = spawnSync(cmd, args, {
    cwd: o.cwd,
    env: childEnv(o.env),
    stdio: o.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) fail(cmd + ' could not be started: ' + res.error.message, 127)
  if (res.status !== 0) {
    if (o.allowFail) return { status: res.status, stdout: res.stdout || '' }
    if (o.capture && res.stderr) process.stderr.write(redact(res.stderr))
    fail(cmd + ' ' + (args[0] || '') + ' failed (exit ' + res.status + ')', res.status || 1)
  }
  return o.allowFail ? { status: 0, stdout: res.stdout || '' } : res.stdout || ''
}

function parseArgs(argv) {
  const opts = { tokenFromEnv: false, skipInstall: false, skipGate: false, workdir: null, result: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--token-from-env') opts.tokenFromEnv = true
    else if (a === '--skip-install') opts.skipInstall = true
    else if (a === '--skip-gate') opts.skipGate = true
    else if (a === '--workdir' || a === '--result') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) return { error: a + ' needs a value' }
      opts[a === '--workdir' ? 'workdir' : 'result'] = v
      i++
    } else if (a === '-h' || a === '--help') return { help: true }
    else return { error: 'unknown option ' + a }
  }
  return opts
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

function checkPlan(plan) {
  const problems = []
  const need = (key, re, what) => {
    const v = plan && plan[key]
    if (typeof v !== 'string' || !re.test(v)) problems.push(key + ' must be ' + what)
  }
  need('slug', /^[a-z][a-z0-9-]*[a-z0-9]$/, 'a slug (lower-case letters, digits, hyphens)')
  need('displayName', /^[^\r\n]+$/, 'one line of text')
  need('domain', /^[a-z0-9.-]+\.[a-z]{2,}$/i, 'a domain like example.com')
  need('repo', /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'owner/name')
  need('kitRepo', /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'owner/name')
  need('tag', /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/, 'a tag name')
  need('commit', /^[0-9a-f]{40}$/, 'a full commit SHA')
  if (problems.length) fail('The scaffold plan is not usable: ' + problems.join('; '), 1)
  return plan
}

async function request(method, url, init) {
  const i = init || {}
  const headers = { Accept: 'application/json', 'User-Agent': 'launch-scaffold' }
  if (i.bearer) headers.Authorization = 'Bearer ' + i.bearer
  if (i.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers,
    body: i.body === undefined ? undefined : JSON.stringify(i.body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json, text }
}

/** The job's GitHub Actions OIDC token for audience LAUNCH_URL. */
async function oidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) {
    fail('No GitHub Actions OIDC token: the job needs permissions id-token: write (or run with --token-from-env)', 1)
  }
  const u = new URL(url)
  u.searchParams.set('audience', audience)
  const res = await request('GET', u.toString(), { bearer })
  const value = res.json && res.json.value
  if (!res.ok || typeof value !== 'string') fail('GitHub did not issue an OIDC token (HTTP ' + res.status + ')', 1)
  addSecret(value)
  return value
}

function launchError(res) {
  const e = res.json && typeof res.json.error === 'string' ? res.json.error : res.text.slice(0, 300)
  return 'HTTP ' + res.status + (e ? ': ' + e : '')
}

/** The push token and the plan: from Launch (a GitHub job) or from the environment. */
async function obtainGrant(opts, launchUrl) {
  if (opts.tokenFromEnv) {
    const token = process.env.LAUNCH_SCAFFOLD_TOKEN
    if (!token) fail('--token-from-env: LAUNCH_SCAFFOLD_TOKEN is not set', 2)
    addSecret(token)
    let plan
    try {
      plan = JSON.parse(process.env.LAUNCH_SCAFFOLD_PLAN || '')
    } catch {
      fail('--token-from-env: LAUNCH_SCAFFOLD_PLAN is not JSON', 2)
    }
    return { token, plan: checkPlan(plan), ticketId: null }
  }
  if (!launchUrl) fail('LAUNCH_URL is not set (the workflow passes inputs.launch_url)', 2)
  const oidc = await oidcToken(launchUrl)
  const res = await request('POST', launchUrl + '/ci/scaffold/token', { bearer: oidc, body: {} })
  if (!res.ok || !res.json || typeof res.json.token !== 'string') {
    fail('Launch refused the scaffold token: ' + launchError(res), 1)
  }
  addSecret(res.json.token)
  return { token: res.json.token, plan: checkPlan(res.json.plan), ticketId: res.json.ticketId || null }
}

/** Git config for the APP repo's clone and push only: the token as an extra header, via env. */
function gitAuthEnv(serverUrl, token) {
  const basic = Buffer.from('x-access-token:' + token).toString('base64')
  addSecret(basic)
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.' + serverUrl + '/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + basic,
  }
}

function git(cwd, args, opts) {
  return run('git', args, { ...(opts || {}), cwd })
}

function replaceTree(appDir, kitDir) {
  for (const entry of fs.readdirSync(appDir)) {
    if (entry !== '.git') fs.rmSync(path.join(appDir, entry), { recursive: true, force: true })
  }
  for (const entry of fs.readdirSync(kitDir)) {
    if (entry === '.git') continue
    fs.cpSync(path.join(kitDir, entry), path.join(appDir, entry), {
      recursive: true,
      verbatimSymlinks: true,
    })
  }
}

/** kit.commit in .rocketflare.json, as the kit's install.sh records it. */
function stampKitCommit(appDir, commit) {
  const file = path.join(appDir, '.rocketflare.json')
  if (!fs.existsSync(file)) fail('.rocketflare.json is missing: this is not a Rocketflare kit', 1)
  const before = fs.readFileSync(file, 'utf8')
  let text = before.replace('"commit": null', '"commit": "' + commit + '"')
  let manifest = JSON.parse(text)
  if (!manifest.kit || manifest.kit.commit !== commit) {
    manifest = JSON.parse(before)
    manifest.kit = { ...(manifest.kit || {}), commit }
    text = JSON.stringify(manifest, null, 2) + '\n'
  }
  fs.writeFileSync(file, text)
}

/** rocketflare#37: keep every rocketflare-dev/ reference through the rename. */
function patchPreserved(appDir) {
  const rel = 'scripts/lib/rename-lib.mjs'
  const file = path.join(appDir, rel)
  if (!fs.existsSync(file)) fail(rel + ' is missing: this is not a Rocketflare kit', 1)
  let text = fs.readFileSync(file, 'utf8')
  const missing = PRESERVE_EXTRA.filter(l => !text.includes("'" + l + "'"))
  if (missing.length) {
    const at = text.indexOf(PRESERVE_ANCHOR)
    if (at === -1) fail('KIT.preserved in ' + rel + ' has no ' + PRESERVE_ANCHOR + ' line to patch after (rocketflare#37)', 1)
    const lineStart = text.lastIndexOf('\n', at) + 1
    const lineEnd = text.indexOf('\n', at) + 1
    const indent = text.slice(lineStart, at)
    const added = missing.map(l => indent + "'" + l + "',\n").join('')
    text = text.slice(0, lineEnd) + added + text.slice(lineEnd)
    fs.writeFileSync(file, text)
  }
  const out = run(
    'node',
    ['--input-type=module', '-e', "import('./" + rel + "').then(m => process.stdout.write(JSON.stringify(m.KIT.preserved)))"],
    { cwd: appDir, capture: true, quiet: true }
  )
  const preserved = JSON.parse(out)
  for (const l of PRESERVE_EXTRA) {
    if (!preserved.includes(l)) fail('KIT.preserved does not include ' + l + ' after the patch', 1)
  }
  for (let i = 0; i < preserved.length; i++) {
    for (let j = i + 1; j < preserved.length; j++) {
      if (preserved[j].includes(preserved[i])) {
        fail('KIT.preserved must be longest first: ' + preserved[i] + ' comes before ' + preserved[j], 1)
      }
    }
  }
  log('KIT.preserved: ' + preserved.join(', '))
}

// Run with the kit's own tsx from the app root. The kit's patchToml writes the binding blocks,
// migrations and vars; the crons and run_worker_first prefixes are appended HERE, because the
// kit's appendToArray (0.15) counts a value quoted in a COMMENT as present, and the kit's tomls
// mention the analytics plugin's "/cubejs-api", "/mcp" and "15 * * * *" in comments.
const PLUGIN_DECLARATIONS_TS = [
  "// Written by Launch's scaffold job and deleted with .launch/: every installed plugin's",
  '// declarations into BOTH tomls, as pnpm provision cloudflare <env> writes them (D31).',
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  "import { readManifest } from '../scripts/lib/manifest.mjs'",
  "import { patchToml, readTomlString } from '../apps/web/scripts/provision/patch-toml'",
  'import {',
  '  pluginBindingBlocks,',
  '  pluginDeclarations,',
  '  pluginMigrationBlocks,',
  '  readPluginResources,',
  "} from '../apps/web/scripts/provision/plugin-resources'",
  '',
  '/** The body of a key = [ ... ] array (comment- and string-aware), or null. */',
  'function arrayRange(text: string, key: string): { start: number; end: number } | null {',
  "  const m = new RegExp('^' + key + '\\\\s*=\\\\s*\\\\[', 'm').exec(text)",
  '  if (!m) return null',
  '  let inString = false',
  '  let inComment = false',
  '  for (let i = m.index + m[0].length; i < text.length; i++) {',
  '    const ch = text[i]',
  "    if (inComment) { if (ch === '\\n') inComment = false; continue }",
  "    if (inString) { if (ch === '\\\\') i++; else if (ch === '\"') inString = false; continue }",
  "    if (ch === '#') inComment = true",
  "    else if (ch === '\"') inString = true",
  "    else if (ch === ']') return { start: m.index + m[0].length, end: i }",
  '  }',
  '  return null',
  '}',
  '',
  '/** The quoted values of an array body, ignoring anything in a comment. */',
  'function arrayValues(inner: string): string[] {',
  '  const out: string[] = []',
  "  for (const line of inner.split('\\n')) {",
  "    let code = ''",
  '    let inString = false',
  '    for (let i = 0; i < line.length; i++) {',
  '      const ch = line[i]',
  "      if (!inString && ch === '#') break",
  "      if (ch === '\"') inString = !inString",
  '      code += ch',
  '    }',
  '    for (const v of code.matchAll(/"([^"]*)"/g)) out.push(v[1])',
  '  }',
  '  return out',
  '}',
  '',
  'function ensureArrayValues(text: string, key: string, values: string[]): string {',
  '  const r = arrayRange(text, key)',
  "  if (!r) throw new Error('no ' + key + ' = [...] array')",
  '  const inner = text.slice(r.start, r.end)',
  '  const present = new Set(arrayValues(inner))',
  '  const missing = values.filter(v => !present.has(v))',
  '  if (missing.length === 0) return text',
  '  let body: string',
  "  if (inner.includes('\\n')) {",
  "    const indent = /\\n([ \\t]+)\\S/.exec(inner)?.[1] ?? '  '",
  "    const close = /\\n([ \\t]*)$/.exec(inner)?.[1] ?? ''",
  "    const head = inner.replace(/\\n[ \\t]*$/, '').replace(/[ \\t]+$/, '')",
  "    body = head + '\\n' + missing.map(v => indent + JSON.stringify(v) + ',').join('\\n') + '\\n' + close",
  '  } else {',
  "    body = [...arrayValues(inner), ...missing].map(v => JSON.stringify(v)).join(', ')",
  '  }',
  '  return text.slice(0, r.start) + body + text.slice(r.end)',
  '}',
  '',
  'const root = process.cwd()',
  'const { manifest } = readManifest(root)',
  'const plugins = readPluginResources(root, manifest?.surfaces ?? [])',
  "const tomls = { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' } as const",
  "const app = readTomlString(fs.readFileSync(path.join(root, tomls.production), 'utf8'), 'name')",
  "if (!app) throw new Error('apps/web/wrangler.toml has no name')",
  'const { crons, apiPrefixes, vars } = pluginDeclarations(plugins)',
  "const prefixes = apiPrefixes.flatMap(p => [p, p + '/*'])",
  'for (const env of Object.keys(tomls) as Array<keyof typeof tomls>) {',
  '  const file = path.join(root, tomls[env])',
  "  const before = fs.readFileSync(file, 'utf8')",
  '  let after = patchToml(before, {',
  '    bindings: pluginBindingBlocks(app, plugins, env),',
  '    migrations: pluginMigrationBlocks(plugins),',
  "    vars: vars.filter(v => !v.secret).map(v => ({ key: v.key, value: v.example ?? '' })),",
  '  })',
  "  if (crons.length) after = ensureArrayValues(after, 'crons', crons)",
  "  if (prefixes.length) after = ensureArrayValues(after, 'run_worker_first', prefixes)",
  "  const r1 = arrayRange(after, 'crons')",
  "  const r2 = arrayRange(after, 'run_worker_first')",
  '  const haveCrons = r1 ? arrayValues(after.slice(r1.start, r1.end)) : []',
  '  const havePrefixes = r2 ? arrayValues(after.slice(r2.start, r2.end)) : []',
  '  const lost = [...crons.filter(c => !haveCrons.includes(c)), ...prefixes.filter(p => !havePrefixes.includes(p))]',
  "  if (lost.length) throw new Error(tomls[env] + ': could not write ' + lost.join(', '))",
  '  if (after !== before) fs.writeFileSync(file, after)',
  "  console.log(tomls[env] + ': plugin declarations ' + (after !== before ? 'written' : 'unchanged') + ' (' + plugins.map(p => p.id).join(', ') + ')')",
  '}',
  '',
].join('\n')

// Kit 0.15 tests a renamed copy fails through no fault of its own (upstream, beside rocketflare#37).
// Each is an exact edit; one whose anchor is gone (fixed upstream, or a different kit) is skipped
// with a warning, and the gate says whether that still matters.
function kitTestPatches(slug) {
  const file = 'apps/web/tests/config/update-check-lib.test.ts'
  return [
    {
      file,
      why: 'the rename rewrote the regex the manifest file name is matched with',
      find: 'toMatch(/no \\.' + slug + '/)',
      replace: 'toMatch(/no \\.rocketflare/)',
    },
    {
      file,
      why: 'a renamed copy is not the kit: its manifest has an app block',
      find: "  it('stays silent in the kit repository itself (its manifest has app: null)'",
      replace:
        '  // Skipped by Launch: a renamed copy is not the kit (its manifest has an app block).\n' +
        "  it.skip('stays silent in the kit repository itself (its manifest has app: null)'",
    },
    {
      // The analytics plugin (3.4.1) ships this test without declaring it in its own
      // unscopedAllowlist. The kit's CI never sees it (the plugin is not committed there); a
      // committed install is scanned, so the reason is recorded here, as Launch itself did.
      file: 'apps/web/tests/config/unscoped-allowlist.test.ts',
      requires: 'apps/web/src/plugins/analytics/tests/api/dashboard-visibility.test.ts',
      why: 'the analytics plugin test the allow-list scan finds once the plugin is committed',
      find: "one flush may hold spans from more than one tenant — D32',\n}",
      replace:
        "one flush may hold spans from more than one tenant — D32',\n" +
        '  // Added by Launch: the analytics plugin ships this test without declaring it in its own\n' +
        '  // unscopedAllowlist, so the entry lives here until the plugin carries it (upstream).\n' +
        "  'src/plugins/analytics/tests/api/dashboard-visibility.test.ts':\n" +
        "    'a TEST, not runtime code: it deletes the group grants of a page it just created by page id (a uuid it owns) to set up the \"empty grant list is private\" case',\n" +
        '}',
    },
    {
      // Its unprovision() regex is unanchored, so under DATABASE_DRIVER=neon it matches the
      // COMMENTED HYPERDRIVE example and rewrites the real 32-hex KV id instead: every copy
      // fails once write_config puts real ids in (upstream kit bug).
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'unprovision() must only match a real HYPERDRIVE block, not the commented example',
      find: '/(binding = "HYPERDRIVE"\\n(?:[^\\n]*\\n)*?id = ")[0-9a-f]{32}(")/,',
      replace: '/(^binding = "HYPERDRIVE"\\n(?:[^\\n]*\\n)*?id = ")[0-9a-f]{32}(")/m,',
    },
    {
      // The shipped production toml has no workers_dev line (its tests insert a note there);
      // write_config adds workers_dev = false to both files, so production's is dropped again.
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'the shipped production shape has no workers_dev line; Launch writes one',
      find: "    .replace(/^routes = \\[/m, '# routes = [')\n}",
      replace:
        "    .replace(/^routes = \\[/m, '# routes = [')\n" +
        "    .replace(/\\n(?:# Launch[^\\n]*\\n)?workers_dev = false\\n/, env === 'production' ? '\\n' : '$&')\n" +
        '}',
    },
    {
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'a note on the two edits above',
      find: "\nfunction unprovision(text: string, env: 'staging' | 'production'): string {",
      replace:
        '\n// Edited by Launch: the HYPERDRIVE match is anchored (it matched the commented example and\n' +
        '// rewrote the real KV id), and write_config’s workers_dev = false is dropped from production.\n' +
        "function unprovision(text: string, env: 'staging' | 'production'): string {",
    },
  ]
}

function patchKitTests(appDir, slug) {
  for (const p of kitTestPatches(slug)) {
    const abs = path.join(appDir, p.file)
    if (!fs.existsSync(abs)) continue
    if (p.requires && !fs.existsSync(path.join(appDir, p.requires))) continue
    const text = fs.readFileSync(abs, 'utf8')
    if (text.includes(p.replace)) continue
    if (!text.includes(p.find)) {
      warn(p.file + ': the patch for "' + p.why + '" no longer applies; skipped')
      continue
    }
    // A function, so a $ in the replacement is literal.
    fs.writeFileSync(abs, text.replace(p.find, () => p.replace))
    log(p.file + ': patched (' + p.why + ')')
  }
}

/** The kit's gate.yml plugin loop, then the declarations and a lockfile that matches. */
function installDefaultPlugins(appDir, slug) {
  const devVars = path.join(appDir, 'apps/web/.dev.vars')
  const createdDevVars = !fs.existsSync(devVars)
  // db:generate runs dotenv -e .dev.vars (as on a laptop); a throwaway URL, never used to connect.
  if (createdDevVars) {
    fs.writeFileSync(devVars, 'DATABASE_URL=postgresql://test:test@localhost:5433/' + slug.replace(/-/g, '_') + '_test\n')
  }
  try {
    const tsv = run('node', ['scripts/default-plugins.mjs', '--tsv'], { cwd: appDir, capture: true })
    const entries = tsv.split('\n').filter(Boolean).map(line => line.split('\t'))
    if (entries.length === 0) log('No default plugins.')
    for (const [id, repo, ref, subdir] of entries) {
      if (!id) continue
      const spec = ref ? repo + '@' + ref : repo
      const args = ['plugin', 'add', spec]
      if (subdir) args.push('--subdir', subdir)
      args.push('--apply', '--allow-dirty')
      run('pnpm', args, { cwd: appDir })
      const version = run(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('./scripts/lib/manifest.mjs').then(({ readManifest }) => { const { manifest } = readManifest(); const s = ((manifest && manifest.surfaces) || []).find(x => x.id === " +
            JSON.stringify(id) +
            "); process.stdout.write((s && s.source && s.source.version) || 'unpinned') })",
        ],
        { cwd: appDir, capture: true, quiet: true }
      ).trim()
      run('pnpm', ['db:generate', '--name', 'plugin-' + id + '-' + version], { cwd: appDir })
    }
    if (entries.length > 0) {
      fs.mkdirSync(path.join(appDir, '.launch'), { recursive: true })
      fs.writeFileSync(path.join(appDir, '.launch/plugin-declarations.ts'), PLUGIN_DECLARATIONS_TS)
      run('pnpm', ['exec', 'tsx', '.launch/plugin-declarations.ts'], { cwd: appDir })
      // docs/plugin-api.md carries used-by annotations from the installed plugins, and the app's
      // gate diffs it: regenerate it now, as the kit's rule for a committed install says.
      if (fs.existsSync(path.join(appDir, 'scripts/plugin-api-doc.mjs'))) {
        run('node', ['scripts/plugin-api-doc.mjs'], { cwd: appDir })
      }
    }
    run('pnpm', ['install'], { cwd: appDir })
    if (run('pnpm', ['lint:fix'], { cwd: appDir, allowFail: true }).status !== 0) {
      warn('pnpm lint:fix reported problems it could not fix; the gate will show them')
    }
  } finally {
    if (createdDevVars) fs.rmSync(devVars, { force: true })
  }
}

function removeLaunchOnlyFiles(appDir) {
  for (const f of KIT_ONLY_WORKFLOWS) {
    fs.rmSync(path.join(appDir, '.github/workflows', f), { force: true })
  }
  for (const f of KIT_ONLY_FILES) fs.rmSync(path.join(appDir, f), { force: true })
  fs.rmSync(path.join(appDir, SCAFFOLD_WORKFLOW), { force: true })
  fs.rmSync(path.join(appDir, '.launch'), { recursive: true, force: true })
}

async function revoke(apiUrl, token) {
  try {
    const res = await request('DELETE', apiUrl + '/installation/token', { bearer: token })
    if (res.status === 204 || res.ok) log('Push token revoked.')
    else warn('Could not revoke the push token (HTTP ' + res.status + '); it expires within the hour')
  } catch (err) {
    warn('Could not revoke the push token (' + (err && err.message) + '); it expires within the hour')
  }
}

async function reportDone(launchUrl, commit) {
  let last = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const oidc = await oidcToken(launchUrl)
      const res = await request('POST', launchUrl + '/ci/scaffold/done', { bearer: oidc, body: { commit } })
      if (res.ok) return
      last = launchError(res)
      if (res.status < 500) break
    } catch (err) {
      if (err instanceof StepError) throw err
      last = err && err.message
    }
    await new Promise(r => setTimeout(r, attempt * 2000))
  }
  fail('Launch did not accept the scaffold result: ' + last, 1)
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    log(USAGE)
    return 0
  }
  if (opts.error) {
    process.stderr.write('error: ' + opts.error + '\n\n' + USAGE + '\n')
    return 2
  }
  const launchUrl = trimSlash(process.env.LAUNCH_URL)
  const serverUrl = trimSlash(process.env.GITHUB_SERVER_URL || 'https://github.com')
  const apiUrl = trimSlash(process.env.GITHUB_API_URL || 'https://api.github.com')

  step('Get the push token and the plan')
  const grant = await obtainGrant(opts, launchUrl)
  const plan = grant.plan
  log('Scaffolding ' + plan.repo + ' as ' + plan.slug + ' (' + plan.displayName + ') from ' + plan.kitRepo + ' ' + plan.tag)

  let commit = null
  try {
    const work = opts.workdir ? path.resolve(opts.workdir) : fs.mkdtempSync(path.join(os.tmpdir(), 'launch-scaffold-'))
    fs.mkdirSync(work, { recursive: true })
    const appDir = path.join(work, 'app')
    const kitDir = path.join(work, 'kit')
    const auth = gitAuthEnv(serverUrl, grant.token)

    step('Clone the app repository and the kit')
    // A full clone (one commit): the kit's own tests read HEAD~1 once the scaffold is committed.
    git(work, ['clone', '--quiet', serverUrl + '/' + plan.repo + '.git', appDir], { env: auth })
    if (git(appDir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true, capture: true, quiet: true }).status !== 0) {
      git(appDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    git(work, ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', plan.tag, serverUrl + '/' + plan.kitRepo + '.git', kitDir])
    const kitCommit = git(kitDir, ['rev-parse', 'HEAD'], { capture: true, quiet: true }).trim()
    if (kitCommit !== plan.commit) {
      fail('The kit tag ' + plan.tag + ' is ' + kitCommit + ', not the pinned ' + plan.commit + ': refusing a moved tag', 1)
    }
    log('Kit ' + plan.kitRepo + ' ' + plan.tag + ' is ' + kitCommit + ' (as pinned).')

    step('Copy the kit into the app')
    replaceTree(appDir, kitDir)
    stampKitCommit(appDir, kitCommit)
    git(appDir, ['add', '-A'])

    step('Keep the rocketflare-dev/ references (rocketflare#37)')
    patchPreserved(appDir)

    step('Rename the kit to ' + plan.slug)
    const renameArgs = ['scripts/rename.mjs', plan.slug, plan.displayName, '--domain', plan.domain, '--force']
    if (opts.skipInstall) renameArgs.push('--skip-install')
    run('node', renameArgs, { cwd: appDir })
    git(appDir, ['add', '-A'])
    const leftovers = git(appDir, ['grep', '-n', '-F', plan.slug + '-dev/'], { allowFail: true, capture: true, quiet: true })
    if (leftovers.status === 0 && leftovers.stdout.trim()) {
      warn('The rename left ' + plan.slug + '-dev/ references (rocketflare#37):\n' + leftovers.stdout.trim())
    }

    if (opts.skipInstall) log('--skip-install: no default plugins, no lockfile update.')
    else {
      step('Install the default plugins')
      installDefaultPlugins(appDir, plan.slug)
    }

    step('Remove the kit-only workflows and the scaffold job')
    removeLaunchOnlyFiles(appDir)
    patchKitTests(appDir, plan.slug)

    // Committed BEFORE the gate: the kit's config tests read the history (HEAD~1).
    step('Commit')
    const authorName = process.env.LAUNCH_SCAFFOLD_AUTHOR_NAME || 'Launch'
    let host = 'localhost'
    try {
      host = launchUrl ? new URL(launchUrl).hostname : host
    } catch {}
    const authorEmail = process.env.LAUNCH_SCAFFOLD_AUTHOR_EMAIL || 'launch@' + host
    const identity = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    }
    const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? serverUrl + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID
      : null
    const body = [
      'Kit: ' + plan.kitRepo + ' ' + plan.tag + ' (' + kitCommit + ')',
      'Renamed to ' + plan.slug + ' ("' + plan.displayName + '") and scaffolded by Launch.',
    ]
    if (runUrl) body.push('Run: ' + runUrl)
    git(appDir, ['add', '-A'])
    git(appDir, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'Start from Rocketflare ' + plan.tag, '-m', body.join('\n')], {
      env: identity,
    })

    if (opts.skipGate) log('--skip-gate: the gate did not run.')
    else {
      step('The gate: lint, typecheck, config tests')
      run('pnpm', ['lint'], { cwd: appDir })
      run('pnpm', ['typecheck'], { cwd: appDir })
      run('pnpm', ['web', 'test:config'], { cwd: appDir })
      // typecheck regenerates worker-configuration.d.ts: what the gate wrote joins the commit.
      git(appDir, ['add', '-A'])
      if (git(appDir, ['diff', '--cached', '--quiet'], { allowFail: true, quiet: true }).status !== 0) {
        git(appDir, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--amend', '--no-edit'], {
          env: identity,
        })
      }
    }

    step('Push main')
    git(appDir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], { env: auth })
    commit = git(appDir, ['rev-parse', 'HEAD'], { capture: true, quiet: true }).trim()
    log('Pushed ' + commit + ' to ' + plan.repo + ' main.')
  } finally {
    step('Revoke the push token')
    await revoke(apiUrl, grant.token)
  }

  if (!opts.tokenFromEnv) {
    step('Tell Launch')
    await reportDone(launchUrl, commit)
    log('Launch has the scaffold.')
  }
  if (opts.result) {
    fs.writeFileSync(opts.result, JSON.stringify({ commit, ticketId: grant.ticketId }) + '\n')
  }
  if (openGroup && inActions) process.stdout.write('::endgroup::\n')
  log('scaffold: ok ' + commit)
  return 0
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code
  },
  err => {
    if (openGroup && inActions) process.stdout.write('::endgroup::\n')
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(redact((inActions ? '::error::' : 'error: ') + message) + '\n')
    process.exitCode = err instanceof StepError ? err.exitCode : 1
  }
)
`

/**
 * The two files `repo` commits (with `commitFiles`) before the job is dispatched. The script is
 * `100755` so a person can also run it directly.
 */
export function scaffoldFiles(): CommitFile[] {
  return [
    { path: SCAFFOLD_WORKFLOW_PATH, content: SCAFFOLD_WORKFLOW_YAML },
    { path: SCAFFOLD_SCRIPT_PATH, content: SCAFFOLD_SCRIPT, mode: '100755' },
  ]
}
