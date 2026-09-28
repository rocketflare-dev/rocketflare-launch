#!/usr/bin/env node
/**
 * A tiny git smart-HTTP server for LOCAL coding sessions (Launch P3, `docs/SESSIONS-LOCAL.md`):
 * `SESSION_BACKEND=local` sessions clone from and push to it instead of GitHub. The session's
 * container still asks for `https://github.com/<owner>/<repo>.git`; Launch's GitHub egress handler
 * (`services/sessions/egress/github.ts`) forwards it here (`SESSION_LOCAL_GIT_URL`), so the
 * Workflow runs the same commands in both backends.
 *
 *   node scripts/sessions-local-git.mjs serve [--port 9420] [--root <dir>]
 *   node scripts/sessions-local-git.mjs add <owner>/<repo> --from <path|url> [--ref <ref>] [--root <dir>]
 *   node scripts/sessions-local-git.mjs list [--root <dir>]
 *   node scripts/sessions-local-git.mjs log <owner>/<repo> [<branch>] [--root <dir>]
 *
 * Repositories are bare, under `--root` (default `~/.launch/sessions-git/<owner>/<repo>.git`), with
 * `http.receivepack` on so a session can push `session/<short>`. `add` makes `main` point at
 * `--ref` (a tag such as the kit's `0.15.0`), which is what a session branches from.
 *
 * `serve` runs `git http-backend` (git's own CGI) per request — the one server that speaks the
 * protocol exactly as git expects, v2 included. It binds 0.0.0.0 so a container can reach it as
 * `host.docker.internal`; it takes no credential, so run it only on a machine you trust.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PORT = 9420
const DEFAULT_ROOT = path.join(os.homedir(), '.launch', 'sessions-git')

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2)
      flags[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true')
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function fail(message, code = 2) {
  process.stderr.write(`sessions-local-git: ${message}\n`)
  process.exit(code)
}

function git(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', ...opts })
  if (result.status !== 0)
    fail(`git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`, 1)
  return result.stdout.trim()
}

/** `owner/repo` → the bare repository's directory. Refuses anything but two safe segments. */
function repoDir(root, slug) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(slug ?? '')
  if (!match || match[1].startsWith('.') || match[2].startsWith('.')) {
    fail(`expected <owner>/<repo>, got ${slug}`)
  }
  return path.join(root, match[1], `${match[2]}.git`)
}

function add(root, slug, flags) {
  if (!flags.from) fail('add needs --from <path|url>')
  const dir = repoDir(root, slug)
  if (existsSync(dir)) fail(`${dir} already exists (remove it to start again)`)
  mkdirSync(path.dirname(dir), { recursive: true })
  git(['clone', '--quiet', '--bare', '--no-local', flags.from, dir])
  const ref = flags.ref ?? 'HEAD'
  const sha = git(['--git-dir', dir, 'rev-parse', `${ref}^{commit}`])
  git(['--git-dir', dir, 'update-ref', 'refs/heads/main', sha])
  git(['--git-dir', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['--git-dir', dir, 'config', 'http.receivepack', 'true'])
  git(['--git-dir', dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true'])
  process.stdout.write(`added ${slug} at ${dir}\n  main = ${ref} (${sha.slice(0, 12)})\n`)
}

function list(root) {
  if (!existsSync(root)) return
  for (const owner of readdirSync(root)) {
    for (const repo of readdirSync(path.join(root, owner))) {
      const dir = path.join(root, owner, repo)
      const heads = git([
        '--git-dir',
        dir,
        'for-each-ref',
        '--format=%(refname:short) %(objectname:short)',
        'refs/heads',
      ])
      process.stdout.write(
        `${owner}/${repo.replace(/\.git$/, '')}\n${heads.replace(/^/gm, '  ')}\n`
      )
    }
  }
}

function log(root, slug, branch) {
  const dir = repoDir(root, slug)
  process.stdout.write(
    `${git(['--git-dir', dir, 'log', '--oneline', '-n', '20', branch ?? 'main'])}\n`
  )
}

/** One request through `git http-backend` (CGI): the request body in, headers + body out. */
function handle(root, req, res) {
  const url = new URL(req.url ?? '/', 'http://local')
  // `/<owner>/<repo>[.git]/<rest>` → the bare repository's own path.
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(\/.*)$/.exec(url.pathname)
  if (!match || !existsSync(repoDir(root, `${match[1]}/${match[2]}`))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such repository\n')
    return
  }
  const started = Date.now()
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${match[1]}/${match[2]}.git${match[3]}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      REMOTE_USER: 'launch-session',
      REMOTE_ADDR: req.socket.remoteAddress ?? '',
    },
  })
  req.pipe(child.stdin)
  let head = Buffer.alloc(0)
  let headersDone = false
  child.stdout.on('data', chunk => {
    if (headersDone) {
      res.write(chunk)
      return
    }
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    headersDone = true
    let status = 200
    const headers = {}
    for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
      const at = line.indexOf(':')
      if (at < 0) continue
      const name = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200
      else headers[name] = value
    }
    res.writeHead(status, headers)
    res.write(head.subarray(end + 4))
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('close', code => {
    if (!headersDone)
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('git http-backend failed\n')
    else res.end()
    const service = url.searchParams.get('service') ?? match[3].slice(1)
    process.stdout.write(
      `${req.method} ${match[1]}/${match[2]} ${service} → ${code === 0 ? 'ok' : `exit ${code}`} ${Date.now() - started}ms\n`
    )
  })
}

function serve(root, port) {
  mkdirSync(root, { recursive: true })
  const server = http.createServer((req, res) => handle(root, req, res))
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`sessions-local-git: serving ${root} on http://0.0.0.0:${port}\n`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const root = path.resolve(flags.root ?? process.env.SESSIONS_LOCAL_GIT_ROOT ?? DEFAULT_ROOT)
const [command, target, extra] = positional
if (command === 'serve') serve(root, Number(flags.port ?? DEFAULT_PORT))
else if (command === 'add') add(root, target, flags)
else if (command === 'list') list(root)
else if (command === 'log') log(root, target, extra)
else {
  process.stdout.write(
    'usage: sessions-local-git serve [--port 9420] | add <owner>/<repo> --from <path|url> [--ref <ref>] | list | log <owner>/<repo> [branch]   (all take --root <dir>)\n'
  )
  process.exit(command ? 2 : 0)
}
