/**
 * `pnpm provision github-app` — the instance's GitHub App in two clicks, through GitHub's app
 * MANIFEST flow (docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest,
 * checked 2026-10-04):
 *
 *   1. A local server on 127.0.0.1 serves a page that POSTs `manifest` (JSON) to
 *      `https://github.com/organizations/<org>/settings/apps/new?state=<state>`. The person
 *      reviews the prefilled app and clicks **Create**.
 *   2. GitHub redirects to the manifest's `redirect_url` (back to this server) with `?code=&state=`.
 *   3. `POST https://api.github.com/app-manifests/{code}/conversions` (no auth; the code is
 *      single-use and expires in an hour) answers `{ id, slug, html_url, owner, pem, … }`.
 *   4. `GITHUB_APP_ID` goes into the instance file, the PEM to `.launch/github-app.pem` (0600) and
 *      its path into the file as `GITHUB_APP_PRIVATE_KEY_FILE`; the slug into the state.
 *   5. The installation page opens: the person clicks **Install** on the org.
 *
 * The permissions are Launch's own required set (`REQUIRED_GITHUB_PERMISSIONS`, the one the Setup
 * check holds an installation to), so the app is created already passing it. No webhook: Launch
 * polls, so `hook_attributes.active` is false. The conversion also returns a client secret and a
 * webhook secret; neither is used and neither is written anywhere.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { REQUIRED_GITHUB_PERMISSIONS } from '../../src/api/services/launch/setup'
import {
  capture,
  DEFAULT_GITHUB_APP_PEM,
  heading,
  log,
  ProvisionError,
  ROOT_DIR,
  requireInstance,
  TOKEN_FILE_LABEL,
  token,
  verifyLine,
  writeDeployFileValues,
  writeState,
} from './config'
import { registerSecrets } from './redact'

export interface GitHubAppManifest {
  name: string
  url: string
  description: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  public: boolean
  default_permissions: Record<string, 'read' | 'write'>
  default_events: string[]
}

/** The manifest GitHub prefills its "create app" page from. Pure. */
export function buildGitHubAppManifest(input: {
  name: string
  appUrl: string
  redirectUrl: string
}): GitHubAppManifest {
  return {
    name: input.name.slice(0, 34),
    url: input.appUrl,
    description: `Launch at ${input.appUrl} — creates, ships and runs the organization's internal apps.`,
    // Launch never receives a webhook (it polls); GitHub still wants a URL in the object.
    hook_attributes: { url: `${input.appUrl}/api/github/webhook`, active: false },
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: { ...REQUIRED_GITHUB_PERMISSIONS } as Record<string, 'read' | 'write'>,
    default_events: [],
  }
}

export function manifestFormUrl(org: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`
}

export const installUrl = (slug: string): string =>
  `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The one page the local server serves: the manifest form, submitted on load. */
export function manifestPage(action: string, manifest: GitHubAppManifest): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create the GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto">
<h1>Create Launch's GitHub App</h1>
<p>GitHub opens with the app prefilled for <strong>${escapeHtml(action.split('/')[4] ?? '')}</strong>. Review it and click <em>Create GitHub App</em>; you come back here once it exists.</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('f').submit()</script>
</body></html>`
}

interface Conversion {
  id: number
  slug: string
  html_url: string
  owner?: { login?: string }
  pem: string
}

async function convert(code: string, fetchImpl: typeof fetch = fetch): Promise<Conversion> {
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'launch-provision' },
    }
  )
  const body = (await res.json().catch(() => ({}))) as Partial<Conversion> & { message?: string }
  if (!res.ok || !body.id || !body.pem || !body.slug)
    throw new ProvisionError(
      `GitHub refused the manifest code (${res.status} ${body.message ?? 'no app in the answer'}) — rerun \`pnpm provision github-app\``
    )
  registerSecrets([body.pem])
  return body as Conversion
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  capture(cmd, [url])
}

export async function githubAppPhase(flags: { rotate: boolean }): Promise<void> {
  heading('github-app')
  const instance = requireInstance()
  const existing = token('GITHUB_APP_ID')
  if (existing && !flags.rotate) {
    verifyLine(
      `github-app ok — GITHUB_APP_ID is already set in ${TOKEN_FILE_LABEL} (pass --rotate to create a new app)`
    )
    return
  }

  const state = randomBytes(16).toString('hex')
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (err: Error) => void = () => {}
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code')
      if (url.searchParams.get('state') !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('state mismatch — start again')
        return
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<!doctype html><p style="font-family: system-ui">The app exists. Back in the terminal: the installation page opens next — click <strong>Install</strong> on your organization.</p>'
        )
      resolveCode(code)
      return
    }
    if (url.pathname !== '/') {
      res.writeHead(404).end()
      return
    }
    const port = (server.address() as AddressInfo).port
    const manifest = buildGitHubAppManifest({
      name: instance.githubAppName,
      appUrl: instance.appUrl,
      redirectUrl: `http://127.0.0.1:${port}/callback`,
    })
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(manifestPage(manifestFormUrl(instance.githubOrg, state), manifest))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const start = `http://127.0.0.1:${port}/`
  log(`Opening ${start} — it forwards to GitHub with the app prefilled for ${instance.githubOrg}.`)
  log('Click "Create GitHub App" there (you need to be an owner of the organization).')
  openInBrowser(start)
  const timer = setTimeout(
    () =>
      rejectCode(new ProvisionError('no answer from GitHub within 15 minutes — rerun the phase')),
    15 * 60_000
  )
  let code: string
  try {
    code = await codePromise
  } finally {
    clearTimeout(timer)
    server.close()
  }

  const app = await convert(code)
  const pemRel = DEFAULT_GITHUB_APP_PEM
  const pemAbs = path.join(ROOT_DIR, pemRel)
  fs.mkdirSync(path.dirname(pemAbs), { recursive: true, mode: 0o700 })
  fs.writeFileSync(pemAbs, app.pem, { mode: 0o600 })
  fs.chmodSync(pemAbs, 0o600)
  writeDeployFileValues({ GITHUB_APP_ID: String(app.id), GITHUB_APP_PRIVATE_KEY_FILE: pemRel })
  writeState({ githubApp: { slug: app.slug, htmlUrl: app.html_url, owner: app.owner?.login } })
  log(
    `created ${app.slug} (id ${app.id}); key → ${pemRel} (0600); GITHUB_APP_ID → ${TOKEN_FILE_LABEL}`
  )
  const install = installUrl(app.slug)
  log(`Install it on ${instance.githubOrg}: ${install} (opening now — choose "All repositories")`)
  openInBrowser(install)
  verifyLine(
    `github-app ok — app ${app.slug} (id ${app.id}) owned by ${app.owner?.login ?? instance.githubOrg}; GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE written to ${TOKEN_FILE_LABEL}; install at ${install}`
  )
}

/** The PEM `GITHUB_APP_PRIVATE_KEY_FILE` points at (relative to the repo root), or undefined. */
export function readGitHubAppKey(): string | undefined {
  const file = token('GITHUB_APP_PRIVATE_KEY_FILE')
  if (!file) return undefined
  const abs = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file)
  if (!fs.existsSync(abs))
    throw new ProvisionError(
      `GITHUB_APP_PRIVATE_KEY_FILE points at ${file}, which does not exist — restore it from your backup of .launch/, or rerun \`pnpm provision github-app --rotate\``
    )
  const pem = fs.readFileSync(abs, 'utf8')
  registerSecrets([pem.trim()])
  return pem
}
