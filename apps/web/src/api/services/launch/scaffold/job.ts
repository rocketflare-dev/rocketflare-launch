/**
 * The one-shot scaffold job (plan §1, generic since D36 K3): the two files Launch commits into a
 * new app's EMPTY repo (`auto_init`) through the Git Data API before dispatching the job — the
 * workflow `.github/workflows/launch-scaffold.yml` and the script `.launch/scaffold.mjs` — as
 * strings. The job runs in the new repo on a GitHub-hosted runner, because building the app needs
 * what a Worker cannot do: Node, the kit's own init, its package manager and linters.
 *
 * **The script is generated per kit** ({@link scaffoldScript}): the app's kit manifest
 * (`launch.kit.json`, the snapshot ON the app — `apps.kit_manifest`, D36 K2) is embedded in it as
 * `KIT` when Launch commits it, so the job never refetches the manifest and a retry runs exactly
 * what Launch planned. What it does, in order, stopping at the first failure with that step's exit
 * code (`set -e`):
 *
 *  1. **Get a push token and the plan.** In a GitHub job: request the job's OIDC token for the
 *     audience `LAUNCH_URL` and `POST $LAUNCH_URL/ci/scaffold/token` (`/ci/kit-check/token` for a
 *     kit's dynamic conformance check) → a one-hour installation token scoped to this repo
 *     (`contents` + `workflows` write), the plan, and — when the kit repo is one the GitHub App is
 *     installed on (a private kit) — a read-only token for THAT repo (`kitToken`, `contents: read`).
 *     `--token-from-env` instead reads `LAUNCH_SCAFFOLD_TOKEN`, `LAUNCH_SCAFFOLD_KIT_TOKEN`
 *     (optional) and `LAUNCH_SCAFFOLD_PLAN` (JSON) — the P3 sandbox and the tests. Every token is
 *     masked (`::add-mask::`), never an argv, never printed; git receives each as an
 *     `http.<server>/.extraheader` through `GIT_CONFIG_*` env, on its own repo's commands only.
 *  2. Clone the app repo (its `main`) and the kit at the plan's tag, and **refuse unless the tag
 *     resolves to the pinned commit** — a moved tag is a different kit. A plan with no tag is a
 *     COMMIT pin: `git init` + `fetch --depth 1 origin <sha>` + `checkout FETCH_HEAD`. A kit at the
 *     pin whose own `launch.kit.json` names another `kit.id` than the embedded one is refused.
 *  3. Replace the app's tree with the kit's (history stays the app's).
 *  4. `scaffold.init` with `{slug}`, `{display}`, `{domain}` substituted, each value shell-quoted,
 *     run by `sh -c`.
 *  5. Delete the `scaffold.kitOnly` globs.
 *  6. **Stamp `scaffold.appManifest`**: `kit.commit` (always), `kit.version` and `kit.id` when init
 *     left them out. The `app {slug, display, domain}` block is init's job: a slug that is not the
 *     plan's fails the job.
 *  7. `scaffold.postInit`, in order; then `plugins.defaults`, each through `plugins.add` (`{id}`,
 *     `{repo}`, `{ref}`, `{subdir}`), when the kit declares both.
 *  8. Delete `.launch/` and the scaffold workflow, and commit "Start from <kit name> <tag>" (a commit
 *     pin: "… @<short sha>") as Launch — before the gate: some kits' tests read HEAD~1.
 *  9. **The gate**: `ci.gateList` (its output may follow a package manager's header lines — the
 *     outermost `{…}` is parsed, gate list schema 1), then `ci.gateRun` for the `lint` and
 *     `typecheck` steps; the first PR's CI runs the full gate. Whatever it regenerated is amended
 *     in. Push `main` (never forced).
 * 10. Revoke the tokens (always — on failure too) and, in a GitHub job, `POST …/done { commit }`
 *     with a FRESH OIDC token.
 *
 * **Pre-contract Rocketflare** (every release up to 0.17.x: `kit.id` `rocketflare` and no
 * `launch.kit.json` at the pin) also gets the legacy steps of `rocketflare-legacy.ts` — the
 * preserved-org patch, the kit's own default-plugins loop and declarations, the kit test patches
 * and its old gate — each gated on the versions it applies to, with its upstream issue.
 *
 * Flags: `--token-from-env`, `--skip-install` (no postInit and no plugins), `--skip-gate`,
 * `--workdir <dir>` (kept afterwards), `--result <file>` (writes `{ commit, ticketId }`). Env:
 * `LAUNCH_URL`, `GITHUB_SERVER_URL` (clone and push base, default `https://github.com`),
 * `GITHUB_API_URL` (default `https://api.github.com`), `LAUNCH_SCAFFOLD_AUTHOR_NAME` / `_EMAIL`.
 * Exit 0 ok · 2 usage · otherwise the failing step's.
 *
 * `tests/config/scaffold-script.test.ts` executes it with Node against a fixture Rocketflare kit,
 * and `tests/config/scaffold-generic.test.ts` against the meta-kit's manifest, each with a local
 * bare origin. The script is kept free of backticks and `${` so this file can hold it verbatim.
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import type { CommitFile } from '../github-app'
import { rocketflareFallbackManifest } from '../kits/rocketflare-fallback'
import { ROCKETFLARE_LEGACY_SCRIPT } from './rocketflare-legacy'

/** The workflow file's name — the `workflowFile` `/ci/scaffold` requires of the caller's token. */
export const SCAFFOLD_WORKFLOW_FILE = 'launch-scaffold.yml'
export const SCAFFOLD_WORKFLOW_PATH = `.github/workflows/${SCAFFOLD_WORKFLOW_FILE}`
export const SCAFFOLD_SCRIPT_PATH = '.launch/scaffold.mjs'

/**
 * The messages of the commits that put the job's two files on the app's `main`. `[skip ci]`
 * because that push would otherwise run the app's own `ci.yml`, whose linter may lint
 * `.launch/scaffold.mjs` and fail — a red run on `main` for a commit that is not app code. It
 * suppresses only push/pull_request-triggered workflows: the dispatched `launch-scaffold.yml` still
 * runs. "Configure the app for Launch" (`write_config`) must NOT carry it — that commit is app
 * code, and its green CI is what lets the deploy skip re-gating (kit 0.15.3's gate-once).
 */
export const SCAFFOLD_JOB_COMMIT_MESSAGES = {
  add: 'Add the Launch scaffold job [skip ci]',
  update: 'Update the Launch scaffold job [skip ci]',
} as const

/** Where the job trades its OIDC token: an app's scaffold, or a kit's dynamic conformance check. */
export type ScaffoldEndpoint = '/ci/scaffold' | '/ci/kit-check'

/** What the job knows of its kit: the manifest fields it drives, embedded as `KIT`. */
export interface ScaffoldJobKit {
  id: string
  name: string
  /** Where the kit's version lives (`kit.version`). */
  version: { file: string; field: string }
  init: string
  kitOnly: string[]
  postInit: string[]
  appManifest: string
  gateList: string
  gateRun: string
  /** Null: the kit installs no plugins at scaffold time. */
  plugins: {
    add: string
    defaults: { id: string; repo: string; ref: string; subdir?: string }[]
  } | null
}

/** The part of a manifest the job runs (see {@link ScaffoldJobKit}). Pure. */
export function scaffoldJobKit(manifest: KitManifest): ScaffoldJobKit {
  const plugins = manifest.plugins
  return {
    id: manifest.kit.id,
    name: manifest.kit.name,
    version: { file: manifest.kit.version.file, field: manifest.kit.version.field },
    init: manifest.scaffold.init,
    kitOnly: [...manifest.scaffold.kitOnly],
    postInit: [...manifest.scaffold.postInit],
    appManifest: manifest.scaffold.appManifest,
    gateList: manifest.ci.gateList,
    gateRun: manifest.ci.gateRun,
    plugins:
      plugins?.add && plugins.defaults.length > 0
        ? {
            add: plugins.add,
            defaults: plugins.defaults.map(p => ({
              id: p.id,
              repo: p.repo,
              ref: p.ref,
              ...(p.subdir ? { subdir: p.subdir } : {}),
            })),
          }
        : null,
  }
}

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

/** The script's first lines, before the embedded kit. */
const SCRIPT_HEAD = `#!/usr/bin/env node
// Launch's one-shot scaffold job: the pinned kit, initialised as this app, gated, committed and
// pushed to main. Written by Launch from the app's kit manifest; the commit it pushes deletes it.
//
//   node .launch/scaffold.mjs [--token-from-env] [--skip-install] [--skip-gate]
//                             [--workdir <dir>] [--result <file>]
//
// Exit 0 ok, 2 usage, otherwise the exit code of the step that failed. No token is ever printed
// or passed on a command line.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

`

/** Everything after the embedded kit: the generic job. See the module header. */
const SCRIPT_BODY = String.raw`
const USAGE = [
  'usage: node .launch/scaffold.mjs [--token-from-env] [--skip-install] [--skip-gate]',
  '                                 [--workdir <dir>] [--result <file>]',
  '',
  '  --token-from-env  read LAUNCH_SCAFFOLD_TOKEN (push token), LAUNCH_SCAFFOLD_KIT_TOKEN (kit',
  '                    read token, optional) and LAUNCH_SCAFFOLD_PLAN (JSON) instead of trading',
  '                    the GitHub Actions OIDC token at LAUNCH_URL',
  '  --skip-install    skip the kit postInit commands and its default plugins',
  '  --skip-gate       skip the gate (lint, typecheck)',
  '  --workdir <dir>   work there (and keep it) instead of a temporary directory',
  '  --result <file>   write { commit, ticketId } there when the push succeeded',
].join('\n')

const SCAFFOLD_WORKFLOW = '.github/workflows/launch-scaffold.yml'
const GATE_STEPS = ['lint', 'typecheck']

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

/** The environment a child sees: never a token or the OIDC request credentials. */
function childEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.LAUNCH_SCAFFOLD_TOKEN
  delete env.LAUNCH_SCAFFOLD_KIT_TOKEN
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL
  return { ...env, ...(extra || {}) }
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

/** A POSIX shell single-quoted word: nothing inside it is expanded. */
function shQuote(value) {
  return "'" + String(value).split("'").join("'\\''") + "'"
}

/**
 * A manifest command template with {name} placeholders filled, each value shell-quoted. A
 * placeholder Launch does not supply is a contract error (exit 1), never an empty word.
 */
function fillCommand(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      fail('Unknown placeholder {' + name + '} in "' + template + '"', 1)
    }
    return shQuote(values[name])
  })
}

/** What a failed template is called in the error: its first two words (before any placeholder). */
function commandLabel(template) {
  return template.split('{')[0].trim().split(/\s+/).slice(0, 2).join(' ') || template
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
    fail((o.label || cmd + ' ' + (args[0] || '')) + ' failed (exit ' + res.status + ')', res.status || 1)
  }
  return o.allowFail ? { status: 0, stdout: res.stdout || '' } : res.stdout || ''
}

/** A manifest command (a shell line), filled and run by sh -c in cwd. */
function runCommand(template, values, opts) {
  const command = fillCommand(template, values || {})
  log('$ ' + command)
  return run('sh', ['-c', command], { ...(opts || {}), quiet: true, label: commandLabel(template) })
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
  // No tag is a commit pin: an unreleased kit commit, fetched by its SHA.
  if (plan && plan.tag !== undefined && plan.tag !== null && plan.tag !== '') {
    need('tag', /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/, 'a tag name')
  }
  need('commit', /^[0-9a-f]{40}$/, 'a full commit SHA')
  if (problems.length) fail('The scaffold plan is not usable: ' + problems.join('; '), 1)
  // The plan names the app's kit; this job was generated for one kit. A mismatch means the job
  // files on main are stale (Launch re-commits them on a retry).
  if (plan.kitId && plan.kitId !== KIT.id) {
    fail('The plan is for kit ' + plan.kitId + ', but this job was generated for kit ' + KIT.id, 1)
  }
  return { ...plan, tag: plan.tag || null }
}

/** How the plan's kit reads: its tag, or @<short sha> for an unreleased commit. */
function kitLabel(plan) {
  return plan.tag ? plan.tag : '@' + plan.commit.slice(0, 7)
}

/** X.Y.Z (a leading v ignored) below max; an unknown version counts as below (apply the fix). */
function versionBelow(version, max) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(version)
  const b = parse(max)
  if (!a || !b) return true
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** A dotted field of a JSON object, as a non-empty string, or null. */
function fieldOf(json, field) {
  let v = json
  for (const k of String(field).split('.')) v = v && typeof v === 'object' ? v[k] : undefined
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * The kit's version at the pin: kit.version's file and field, else what the kit's own app
 * manifest records (a pre-contract Rocketflare's .rocketflare.json), else null.
 */
function kitVersionOf(kitDir) {
  const own = fieldOf(readJson(path.join(kitDir, KIT.version.file)), KIT.version.field)
  if (own) return own
  return fieldOf(readJson(path.join(kitDir, KIT.appManifest)), 'kit.version')
}

/** The kit at the pin must be the kit this job was generated for (when it says which it is). */
function checkKitIdentity(kitDir) {
  const own = readJson(path.join(kitDir, 'launch.kit.json'))
  const id = own && own.kit && own.kit.id
  if (id && id !== KIT.id) {
    fail('The kit at the pin is ' + id + ' (its launch.kit.json), but this job was generated for ' + KIT.id, 1)
  }
}

/**
 * The kit in kitDir at the pinned commit. A release: a depth-1 clone of the tag, refused unless
 * the tag still resolves to the pinned commit (a moved tag is a different kit). A commit pin: a
 * depth-1 fetch of exactly that SHA (GitHub serves any reachable commit), checked out detached.
 * kitAuth is the kit read token's git config (a private kit), or {} (a public one).
 */
function fetchKit(work, kitDir, serverUrl, plan, kitAuth) {
  const url = serverUrl + '/' + plan.kitRepo + '.git'
  if (plan.tag) {
    git(work, ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', plan.tag, url, kitDir], { env: kitAuth })
  } else {
    fs.mkdirSync(kitDir, { recursive: true })
    git(kitDir, ['-c', 'init.defaultBranch=kit', 'init', '--quiet'])
    git(kitDir, ['remote', 'add', 'origin', url])
    git(kitDir, ['fetch', '--quiet', '--depth', '1', 'origin', plan.commit], { env: kitAuth })
    git(kitDir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'])
  }
  const kitCommit = git(kitDir, ['rev-parse', 'HEAD'], { capture: true, quiet: true }).trim()
  if (kitCommit !== plan.commit) {
    if (plan.tag) {
      fail('The kit tag ' + plan.tag + ' is ' + kitCommit + ', not the pinned ' + plan.commit + ': refusing a moved tag', 1)
    }
    fail('The kit checkout is ' + kitCommit + ', not the pinned ' + plan.commit, 1)
  }
  if (plan.tag) log('Kit ' + plan.kitRepo + ' ' + plan.tag + ' is ' + kitCommit + ' (as pinned).')
  else log('Kit ' + plan.kitRepo + ' @ ' + kitCommit + ' (unreleased commit).')
  return kitCommit
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

/** The push token, the kit read token (or null) and the plan: from Launch, or from the environment. */
async function obtainGrant(opts, launchUrl) {
  if (opts.tokenFromEnv) {
    const token = process.env.LAUNCH_SCAFFOLD_TOKEN
    if (!token) fail('--token-from-env: LAUNCH_SCAFFOLD_TOKEN is not set', 2)
    addSecret(token)
    const kitToken = process.env.LAUNCH_SCAFFOLD_KIT_TOKEN || null
    addSecret(kitToken)
    let plan
    try {
      plan = JSON.parse(process.env.LAUNCH_SCAFFOLD_PLAN || '')
    } catch {
      fail('--token-from-env: LAUNCH_SCAFFOLD_PLAN is not JSON', 2)
    }
    return { token, kitToken, plan: checkPlan(plan), ticketId: null }
  }
  if (!launchUrl) fail('LAUNCH_URL is not set (the workflow passes inputs.launch_url)', 2)
  const oidc = await oidcToken(launchUrl)
  const res = await request('POST', launchUrl + LAUNCH_ENDPOINT + '/token', { bearer: oidc, body: {} })
  if (!res.ok || !res.json || typeof res.json.token !== 'string') {
    fail('Launch refused the scaffold token: ' + launchError(res), 1)
  }
  addSecret(res.json.token)
  const kitToken = typeof res.json.kitToken === 'string' ? res.json.kitToken : null
  addSecret(kitToken)
  return { token: res.json.token, kitToken, plan: checkPlan(res.json.plan), ticketId: res.json.ticketId || null }
}

/** Git config for one repo's commands only: the token as an extra header, via env. */
function gitAuthEnv(serverUrl, token) {
  if (!token) return {}
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

/** A kitOnly glob as a RegExp over repo paths: ** any depth, * and ? within one segment. */
function globRegExp(glob) {
  let re = ''
  const g = String(glob).replace(/^\.\//, '').replace(/\/+$/, '')
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^$()|[\]{}\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '(?:/.*)?$')
}

/** Every path under dir (files and symlinks; directories walked), relative, never .git. */
function listFiles(dir, prefix) {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, prefix || ''), { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    if (!prefix && entry.name === '.git') continue
    if (entry.isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out
}

/** Delete the kit's kitOnly globs from the copy (a no-op for a path init already removed). */
function deleteKitOnly(appDir) {
  if (KIT.kitOnly.length === 0) return
  const patterns = KIT.kitOnly.map(globRegExp)
  let removed = 0
  for (const rel of listFiles(appDir)) {
    if (patterns.some(re => re.test(rel))) {
      fs.rmSync(path.join(appDir, rel), { force: true })
      removed++
    }
  }
  log('kitOnly: ' + removed + ' file' + (removed === 1 ? '' : 's') + ' removed (' + KIT.kitOnly.join(', ') + ')')
}

/**
 * The copy's app manifest after init: init must have recorded the app (its slug is the plan's);
 * the job stamps the kit — commit always, version and id when init left them out. A pre-contract
 * Rocketflare copy names its kit by kit.name (rocketflare): no id is added beside it.
 */
function stampAppManifest(appDir, plan, kit) {
  const rel = KIT.appManifest
  const file = path.join(appDir, rel)
  if (!fs.existsSync(file)) fail('scaffold.init did not write ' + rel + ' (the app manifest)', 1)
  const before = fs.readFileSync(file, 'utf8')
  let manifest = null
  try {
    manifest = JSON.parse(before)
  } catch {
    fail(rel + ' is not JSON after scaffold.init', 1)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(rel + ' is not a JSON object', 1)
  const app = manifest.app || {}
  if (app.slug !== plan.slug) {
    fail(rel + ' names the app ' + (app.slug || 'nothing') + ' after scaffold.init, not ' + plan.slug, 1)
  }
  if (app.display !== undefined && app.display !== plan.displayName) {
    warn(rel + ' records the display name ' + JSON.stringify(app.display) + ', not ' + JSON.stringify(plan.displayName))
  }
  if (app.domain !== undefined && app.domain !== plan.domain) {
    warn(rel + ' records the domain ' + app.domain + ', not ' + plan.domain)
  }
  const current = manifest.kit && typeof manifest.kit === 'object' ? manifest.kit : {}
  const next = { ...current, commit: kit.commit }
  if (!current.version && kit.version) next.version = kit.version
  if (!current.id && current.name !== KIT.id) next.id = KIT.id
  const onlyCommit = Object.keys(next).every(k => k === 'commit' || current[k] === next[k])
  // Only the commit to add, and the kit left it null: one textual edit keeps the file's layout.
  let text = onlyCommit ? before.replace('"commit": null', '"commit": "' + kit.commit + '"') : before
  const reread = JSON.parse(text)
  if (!onlyCommit || !reread.kit || reread.kit.commit !== kit.commit) {
    text = JSON.stringify({ ...manifest, kit: next }, null, 2) + '\n'
  }
  fs.writeFileSync(file, text)
  log(rel + ': app ' + plan.slug + ', kit ' + (next.id || next.name || KIT.id) + ' ' + (next.version || '(no version)') + ' @ ' + kit.commit)
}

/** The kit's default plugins, each through plugins.add. */
function installPlugins(appDir) {
  for (const p of KIT.plugins.defaults) {
    runCommand(KIT.plugins.add, { id: p.id, repo: p.repo, ref: p.ref, subdir: p.subdir || '' }, { cwd: appDir })
  }
}

/** The outermost {...} of a command's output (a package manager may print header lines first). */
function outermostJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** The gate: ci.gateList (schema 1), then ci.gateRun for the lint and typecheck steps. */
function gate(appDir) {
  const out = runCommand(KIT.gateList, {}, { cwd: appDir, capture: true })
  const list = outermostJson(out)
  if (!list || list.schema !== 1 || !Array.isArray(list.steps)) {
    fail('ci.gateList (' + KIT.gateList + ') did not print a gate list (schema 1)', 1)
  }
  const ids = list.steps.map(s => s && s.id)
  const missing = GATE_STEPS.filter(id => !ids.includes(id))
  if (missing.length) fail('The kit gate has no ' + missing.join(' or ') + ' step (it lists ' + ids.join(', ') + ')', 1)
  for (const id of GATE_STEPS) runCommand(KIT.gateRun, { step: id }, { cwd: appDir })
}

/** .launch/ and the scaffold workflow: the job's own files never reach the app. */
function removeJobFiles(appDir) {
  fs.rmSync(path.join(appDir, SCAFFOLD_WORKFLOW), { force: true })
  fs.rmSync(path.join(appDir, '.launch'), { recursive: true, force: true })
}

async function revoke(apiUrl, token, what) {
  if (!token) return
  try {
    const res = await request('DELETE', apiUrl + '/installation/token', { bearer: token })
    if (res.status === 204 || res.ok) log(what + ' revoked.')
    else warn('Could not revoke the ' + what.toLowerCase() + ' (HTTP ' + res.status + '); it expires within the hour')
  } catch (err) {
    warn('Could not revoke the ' + what.toLowerCase() + ' (' + (err && err.message) + '); it expires within the hour')
  }
}

async function reportDone(launchUrl, commit) {
  let last = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const oidc = await oidcToken(launchUrl)
      const res = await request('POST', launchUrl + LAUNCH_ENDPOINT + '/done', { bearer: oidc, body: { commit } })
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
`

/** The job itself, after the legacy fragment (which it calls). */
const SCRIPT_MAIN = String.raw`
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
  log('Scaffolding ' + plan.repo + ' as ' + plan.slug + ' (' + plan.displayName + ') from ' + KIT.name + ' ' + plan.kitRepo + ' ' + kitLabel(plan) + (plan.tag ? '' : ' (unreleased commit)') + (grant.kitToken ? ', read with a kit token' : ''))

  let commit = null
  try {
    const work = opts.workdir ? path.resolve(opts.workdir) : fs.mkdtempSync(path.join(os.tmpdir(), 'launch-scaffold-'))
    fs.mkdirSync(work, { recursive: true })
    const appDir = path.join(work, 'app')
    const kitDir = path.join(work, 'kit')
    const auth = gitAuthEnv(serverUrl, grant.token)
    const kitAuth = gitAuthEnv(serverUrl, grant.kitToken)

    step('Clone the app repository and the kit')
    // A full clone (one commit): some kits' own tests read HEAD~1 once the scaffold is committed.
    git(work, ['clone', '--quiet', serverUrl + '/' + plan.repo + '.git', appDir], { env: auth })
    if (git(appDir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true, capture: true, quiet: true }).status !== 0) {
      git(appDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    const kitCommit = fetchKit(work, kitDir, serverUrl, plan, kitAuth)
    checkKitIdentity(kitDir)
    const kitVersion = kitVersionOf(kitDir)
    const legacy = rocketflareLegacy(kitDir, kitVersion)
    log('Kit ' + KIT.id + ' ' + (kitVersion || '(no version)') + (legacy.on ? ' (pre-contract Rocketflare: the legacy steps apply)' : ''))

    step('Copy the kit into the app')
    replaceTree(appDir, kitDir)
    git(appDir, ['add', '-A'])

    if (legacy.on) {
      if (legacy.before(LEGACY_BEFORE.patchPreserved)) {
        step('Keep the rocketflare-dev/ references (rocketflare#37)')
        patchPreserved(appDir)
      } else {
        log('Rocketflare ' + kitVersion + ' keeps the rocketflare-dev/ references: nothing to patch (rocketflare#37 is fixed in this kit).')
      }
    }

    step('Initialise the kit as ' + plan.slug)
    runCommand(KIT.init, { slug: plan.slug, display: plan.displayName, domain: plan.domain }, { cwd: appDir })
    git(appDir, ['add', '-A'])
    if (legacy.before(LEGACY_BEFORE.patchPreserved)) {
      const leftovers = git(appDir, ['grep', '-n', '-F', plan.slug + '-dev/'], { allowFail: true, capture: true, quiet: true })
      if (leftovers.status === 0 && leftovers.stdout.trim()) {
        warn('The rename left ' + plan.slug + '-dev/ references (rocketflare#37):\n' + leftovers.stdout.trim())
      }
    }

    step('Remove the kit-only files and stamp the app manifest')
    deleteKitOnly(appDir)
    stampAppManifest(appDir, plan, { commit: kitCommit, version: kitVersion })

    if (opts.skipInstall) log('--skip-install: no postInit, no default plugins.')
    else {
      step('After init')
      for (const command of KIT.postInit) {
        // Pre-contract Rocketflare: lint:fix exits non-zero on what it cannot fix; the gate shows it.
        const soft = legacy.on && /lint:fix/.test(command)
        if (runCommand(command, {}, { cwd: appDir, allowFail: soft }).status) {
          warn(command + ' reported problems it could not fix; the gate will show them')
        }
      }
      if (legacy.on) {
        step('Install the default plugins')
        legacyDefaultPlugins(appDir, plan.slug)
      } else if (KIT.plugins) {
        step('Install the default plugins')
        installPlugins(appDir)
      }
    }

    step('Remove the scaffold job')
    removeJobFiles(appDir)
    if (legacy.on) {
      legacyRemoveFiles(appDir, legacy)
      patchKitTests(appDir, plan.slug, legacy)
    }

    // Committed BEFORE the gate: some kits' config tests read the history (HEAD~1).
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
      'Kit: ' + KIT.name + ' ' + plan.kitRepo + ' ' + (plan.tag ? plan.tag + ' (' + kitCommit + ')' : '@ ' + kitCommit + ' (unreleased commit)'),
      'Initialised as ' + plan.slug + ' ("' + plan.displayName + '") and scaffolded by Launch.',
    ]
    if (runUrl) body.push('Run: ' + runUrl)
    git(appDir, ['add', '-A'])
    git(appDir, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'Start from ' + KIT.name + ' ' + kitLabel(plan), '-m', body.join('\n')], {
      env: identity,
    })

    if (opts.skipGate) log('--skip-gate: the gate did not run.')
    else {
      step('The gate: lint, typecheck')
      if (legacy.on) legacyGate(appDir)
      else gate(appDir)
      // A typecheck may regenerate files (worker-configuration.d.ts): what it wrote joins the commit.
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
    step('Revoke the tokens')
    await revoke(apiUrl, grant.token, 'Push token')
    await revoke(apiUrl, grant.kitToken, 'Kit token')
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

export interface ScaffoldScriptOptions {
  /** `/ci/scaffold` (an app, the default) or `/ci/kit-check` (a kit's dynamic check). */
  endpoint?: ScaffoldEndpoint
}

/**
 * `.launch/scaffold.mjs` for one kit: the generic job with the kit's manifest embedded as `KIT`
 * (see the header), plus the Rocketflare-legacy fragment (inert unless the kit at the pin is a
 * pre-contract Rocketflare). Pure: the same manifest is the same script, so a retry's
 * `commitFilesIfChanged` commits nothing.
 */
export function scaffoldScript(manifest: KitManifest, opts: ScaffoldScriptOptions = {}): string {
  const kit = JSON.stringify(scaffoldJobKit(manifest), null, 2)
  return [
    SCRIPT_HEAD,
    "// The kit this job was generated for: Launch's snapshot of its launch.kit.json at plan time.\n",
    `const KIT = ${kit}\n`,
    `const LAUNCH_ENDPOINT = ${JSON.stringify(opts.endpoint ?? '/ci/scaffold')}\n`,
    SCRIPT_BODY,
    ROCKETFLARE_LEGACY_SCRIPT,
    SCRIPT_MAIN,
  ].join('')
}

/** The Rocketflare fallback's script — what every app without a kit manifest of its own runs. */
export const SCAFFOLD_SCRIPT = scaffoldScript(rocketflareFallbackManifest())

/**
 * The two files `repo` commits (with `commitFiles`) before the job is dispatched, for the app's
 * kit manifest (the Rocketflare fallback when none is given). The script is `100755` so a person
 * can also run it directly.
 */
export function scaffoldFiles(
  manifest: KitManifest = rocketflareFallbackManifest(),
  opts: ScaffoldScriptOptions = {}
): CommitFile[] {
  return [
    { path: SCAFFOLD_WORKFLOW_PATH, content: SCAFFOLD_WORKFLOW_YAML },
    { path: SCAFFOLD_SCRIPT_PATH, content: scaffoldScript(manifest, opts), mode: '100755' },
  ]
}
