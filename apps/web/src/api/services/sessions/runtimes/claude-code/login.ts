/**
 * Claude's relayed sign-in (§18.22-A): `claude setup-token`, unmodified, in the login sandbox — the
 * authorize URL relayed out, the code the person pastes relayed in, the year-long inference token
 * it prints captured and sealed (by `loginCaptureStep`, never here).
 *
 * **The relay.** The Sandbox SDK has no stdin, and the base image has no python3 (spike S-0), so
 * the CLI runs under util-linux `script` — a pseudo-terminal — fed by `tail -F` on a file:
 *
 *     tail -n +1 -F <dir>/in | script -q -f -e -c 'stty cols 2000 rows 50; claude setup-token;
 *       echo $? > <dir>/exit' <dir>/out
 *
 * - `stty cols 2000` first: under `script` the terminal is 0×0, and at 2000 columns nothing the CLI
 *   prints wraps. `out` is the terminal's output, flushed as written (`-f`).
 * - A paste is `writeFile(<dir>/in, code + '\r')`; `tail -F` follows the file by name, so a
 *   replaced or truncated file is read again from the start. `\r` is Enter.
 * - The exit code is written by the shell INSIDE the terminal, so it lands as soon as the CLI
 *   exits — `tail` keeps the pipeline alive until the sandbox is destroyed, which `cleanup` does.
 *
 * **What it prints** (fixtures: `tests/fixtures/claude-login/`). The URL is the target of an OSC 8
 * hyperlink (`ESC ] 8 ; id=… ; <url> BEL`) — read it there, not from the visible text, which
 * cursor moves break up. A wrong code prints "OAuth error: Invalid code" and waits for Enter
 * without exiting: `poll` treats it as the end of the login. Success prints "Long-lived
 * authentication token created successfully!" and the `sk-ant-oat01-…` token, then exits 0.
 * Ctrl-C is ignored; a stuck CLI goes with the sandbox.
 *
 * **The token** exists in `out` for the moment between the CLI printing it and `capture` reading
 * it; `capture` removes the whole login directory before it returns (success or not), and the
 * sandbox is destroyed after. It is never in a step result, an event, a log line or an error
 * message — the errors here are fixed sentences.
 */
import type { LoginContext, LoginDriver, LoginPrompt } from '../types'

/**
 * What the login sandbox must reach: the token exchange on `platform.claude.com`, and the account
 * profile on `api.anthropic.com` (already on the base allow-list; non-fatal for setup-token).
 * Both are handled by `egress/anthropic.ts`, which passes only the login's own paths through.
 */
export const CLAUDE_LOGIN_HOSTS = ['platform.claude.com', 'api.anthropic.com'] as const

/** The year Anthropic gives a setup-token token. */
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000

/** Where one login's relay files live. The login id is a uuid, checked before it is used. */
export const CLAUDE_LOGIN_ROOT = '/tmp/launch-login'

const UUIDISH = /^[A-Za-z0-9-]{1,64}$/

export function claudeLoginDir(loginId: string): string {
  if (!UUIDISH.test(loginId)) throw new Error('Claude sign-in: invalid login id')
  return `${CLAUDE_LOGIN_ROOT}/${loginId}`
}

/** The CLI's environment: non-secret, and no browser to open. */
export const CLAUDE_LOGIN_ENV: Readonly<Record<string, string>> = Object.freeze({
  HOME: '/root',
  IS_SANDBOX: '1',
  DISABLE_AUTOUPDATER: '1',
  NODE_USE_SYSTEM_CA: '1',
  BROWSER: '/bin/true',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  TERM: 'xterm-256color',
})

/** The relay command for one login (see the header). */
export function claudeLoginCommand(loginId: string): string {
  const dir = claudeLoginDir(loginId)
  const inner = `stty cols 2000 rows 50; claude setup-token; echo $? > ${dir}/exit`
  return [
    `mkdir -p ${dir}`,
    `: > ${dir}/in`,
    `cd ${dir}`,
    `tail -n +1 -F ${dir}/in 2>/dev/null | script -q -f -e -c '${inner}' ${dir}/out`,
  ].join(' && ')
}

/**
 * Press Enter once the CLI shows the pasted code: up to ~8 s for the mask (8+ `*`) to appear in
 * `out`, then one more second so the relay's next poll carries the Enter on its own.
 */
export function claudeLoginEnterCommand(loginId: string): string {
  const dir = claudeLoginDir(loginId)
  return [
    `for i in $(seq 1 80); do grep -q '[*]\\{8,\\}' ${dir}/out 2>/dev/null && break; sleep 0.1; done`,
    'sleep 1',
    `printf '\\r' >> ${dir}/in`,
  ].join('; ')
}

// ---- reading the terminal --------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
const OSC8_LINK = /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
const OSC_ANY = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
const CSI_MOVE_RIGHT = /\u001b\[\d*[GC]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
const CSI_ANY = /\u001b\[[0-?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
const ESC_OTHER = /\u001b[()][0-9A-Za-z]|\u001b[78=>]|[\u000e\u000f]/g

/**
 * The terminal's output as text: hyperlinks and colours gone, a horizontal cursor move read as a
 * space (the CLI positions each word with one), carriage returns as line ends.
 */
export function claudeLoginScreenText(raw: string): string {
  return raw
    .replace(OSC_ANY, '')
    .replace(CSI_MOVE_RIGHT, ' ')
    .replace(CSI_ANY, '')
    .replace(ESC_OTHER, '')
    .replace(/\r+\n?/g, '\n')
}

/** Hosts whose `/oauth/authorize` page the CLI may send the person to. */
const AUTHORIZE_HOSTS = new Set(['claude.com', 'claude.ai', 'platform.claude.com'])

function authorizeUrl(candidate: string): string | null {
  let url: URL
  try {
    url = new URL(candidate.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !AUTHORIZE_HOSTS.has(url.hostname)) return null
  if (!url.pathname.endsWith('/oauth/authorize')) return null
  return url.toString()
}

/**
 * The Anthropic sign-in URL the CLI printed, or null. The OSC 8 link target first (exact, whatever
 * the visible text did); the visible text only as a fallback.
 */
export function parseClaudeAuthorizeUrl(raw: string): string | null {
  for (const match of raw.matchAll(OSC8_LINK)) {
    const url = authorizeUrl(match[1] ?? '')
    if (url) return url
  }
  for (const match of claudeLoginScreenText(raw).matchAll(/https:\/\/\S+/g)) {
    const url = authorizeUrl(match[0])
    if (url) return url
  }
  return null
}

/** The CLI is asking for the code. */
export function claudeLoginWantsCode(raw: string): boolean {
  return /Paste\s+code\s+here/i.test(claudeLoginScreenText(raw))
}

/** Anthropic refused the pasted code (the CLI then waits for Enter, forever). */
export function claudeLoginRejectedCode(raw: string): boolean {
  return /OAuth\s+error/i.test(claudeLoginScreenText(raw))
}

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{16,}/

/**
 * The token setup-token printed, or null. Never logged, never in an error. Read from the screen
 * text, then from the raw output with the escapes simply dropped — a cursor move read as a space
 * must never be what splits a token in two.
 */
export function parseClaudeSetupToken(raw: string): string | null {
  const bare = raw.replace(OSC_ANY, '').replace(CSI_ANY, '').replace(ESC_OTHER, '')
  const candidates = [TOKEN_RE.exec(claudeLoginScreenText(raw))?.[0], TOKEN_RE.exec(bare)?.[0]]
  // The longer reading wins: a split one is a prefix of the whole.
  return candidates.reduce<string | null>(
    (best, t) => (t && (!best || t.length > best.length) ? t : best),
    null
  )
}

/** Anything secret-shaped the screen may hold: a token, or the pasted `<code>#<state>`. */
const SECRETISH = /sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,}/g

/**
 * The last thing the CLI said, for an error a person (and a log) can read: the final non-empty
 * screen line that is not decoration, secret-shaped runs replaced, clipped. Never the token.
 */
export function claudeLoginLastLine(raw: string): string | null {
  const lines = claudeLoginScreenText(raw)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim().replace(SECRETISH, '[redacted]'))
    // Words left once the secrets are out: a line that was only a code or a token says nothing.
    .filter(line => /[A-Za-z]{3,}/.test(line.replaceAll('[redacted]', '')))
  const last = lines.at(-1)
  if (!last) return null
  return last.length > 200 ? `${last.slice(0, 200)}…` : last
}

function endedWithoutToken(exit: number | null | undefined, raw: string): Error {
  const said = claudeLoginLastLine(raw)
  const how = typeof exit === 'number' ? ` (exit ${exit})` : ''
  return new Error(
    `Claude Code’s sign-in ended without a token${how}${said ? `: “${said}”` : ''}. Start it again.`
  )
}

/** What Anthropic's code page shows: `<code>#<state>`. Checked before it reaches the CLI. */
export const CLAUDE_LOGIN_CODE_RE = /^[^\s#]+#[^\s#]+$/

export function isClaudeLoginCode(code: string): boolean {
  return CLAUDE_LOGIN_CODE_RE.test(code.trim())
}

// ---- the driver ------------------------------------------------------------------------------

const paths = (ctx: LoginContext) => {
  const dir = claudeLoginDir(ctx.loginId)
  return { dir, in: `${dir}/in`, out: `${dir}/out`, exit: `${dir}/exit` }
}

function exitCodeOf(text: string | null): number | null | undefined {
  if (text === null) return undefined
  const n = Number.parseInt(text.trim(), 10)
  return Number.isFinite(n) ? n : null
}

export const claudeLoginDriver: LoginDriver = {
  hosts: CLAUDE_LOGIN_HOSTS,
  needsCode: true,

  async start(ctx) {
    await ctx.sandbox.startProcess(claudeLoginCommand(ctx.loginId), {
      env: { ...CLAUDE_LOGIN_ENV },
    })
  },

  async readPrompt(ctx): Promise<LoginPrompt | null> {
    const p = paths(ctx)
    const out = (await ctx.sandbox.readFile(p.out)) ?? ''
    const url = parseClaudeAuthorizeUrl(out)
    if (url) return { verificationUrl: url, userCode: null }
    if ((await ctx.sandbox.readFile(p.exit)) !== null) {
      throw new Error('Claude Code stopped before it showed a sign-in link. Start it again.')
    }
    return null
  },

  async submitCode(ctx, code) {
    const trimmed = code.trim()
    if (!isClaudeLoginCode(trimmed)) {
      throw new Error(
        'That is not the code Anthropic showed (it has a # in the middle). Start the sign-in again and paste the whole code.'
      )
    }
    const p = paths(ctx)
    // The code, then Enter as a key press of its own. Sent together, the CLI's terminal UI reads
    // "code\r" as one paste and never submits — and so does a gap shorter than the relay's
    // `tail -F` poll (about a second; seen live). So: wait until the CLI has echoed the code (its
    // `****` mask), give it a second more, then append Enter. Appended, never rewritten: `tail -F`
    // replays a replaced file from the start, which would type the code twice.
    await ctx.sandbox.writeFile(p.in, trimmed)
    await ctx.sandbox.exec(claudeLoginEnterCommand(ctx.loginId), { timeoutMs: 15_000 })
  },

  async poll(ctx) {
    const p = paths(ctx)
    // An exit file the shell has opened but not yet written reads as still running.
    const exit = exitCodeOf(await ctx.sandbox.readFile(p.exit))
    if (typeof exit === 'number') return { state: 'exited', exitCode: exit }
    const out = (await ctx.sandbox.readFile(p.out)) ?? ''
    if (claudeLoginRejectedCode(out)) {
      throw new Error(
        'Anthropic did not accept that code. Start the sign-in again and paste the whole code it shows you.'
      )
    }
    return { state: 'running' }
  },

  async capture(ctx) {
    const p = paths(ctx)
    const exit = exitCodeOf(await ctx.sandbox.readFile(p.exit))
    const out = (await ctx.sandbox.readFile(p.out)) ?? ''
    const token = exit === 0 ? parseClaudeSetupToken(out) : null
    if (!token) throw endedWithoutToken(exit, out)
    return {
      kind: 'claude_oauth_token',
      secret: token,
      expiresAt: new Date(Date.now() + CLAUDE_TOKEN_LIFETIME_MS),
      metadata: { method: 'setup-token', scope: 'user:inference' },
    }
  },

  async discard(ctx) {
    // The token is in `out` until this runs (and until `cleanup` destroys the sandbox).
    await ctx.sandbox.exec(`rm -rf ${paths(ctx).dir}`)
  },
}
