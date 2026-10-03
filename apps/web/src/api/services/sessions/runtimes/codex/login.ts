/**
 * Codex's relayed sign-in (§18.22-B): `codex login --device-auth`, unmodified, in the login sandbox
 * with a scratch `CODEX_HOME`. The device URL and the one-time code it prints are relayed out —
 * the person types the code AT OpenAI, so nothing comes back through Launch (`needsCode: false`) —
 * and the `auth.json` it writes on success is captured, its id token decoded for the plan and an
 * account fingerprint, and deleted with the rest of the scratch directory.
 *
 * Every step is stateless across Workflow steps (a retry, or the next step in another isolate), so
 * the CLI runs under a tiny runner that leaves files behind, in `/tmp/launch-login-<id>/`:
 *
 * | file   | what                                                   |
 * |--------|--------------------------------------------------------|
 * | `out`  | stdout — the prompt (ANSI-coloured, Codex 0.160 `device_code_auth.rs`) |
 * | `err`  | stderr — `Successfully logged in` / `Error logging in with device code: …` |
 * | `exit` | the exit code, written atomically when the CLI ends     |
 * | `home/auth.json` | the credential (`cli_auth_credentials_store = "file"`) |
 *
 * The prompt, as Codex 0.160 prints it (colours stripped):
 *
 * ```
 * 1. Open this link in your browser and sign in to your account
 *    https://auth.openai.com/codex/device
 *
 * 2. Enter this one-time code (expires in 15 minutes)
 *    ABCD-EFGH
 * ```
 *
 * Hosts: `auth.openai.com` only — `POST /api/accounts/deviceauth/usercode`, the `…/token` poll and
 * the `/oauth/token` exchange, passed through by `egress/openai-auth.ts` for an active Codex login.
 * A 404 on the usercode call is "device code login is not enabled" — on a workspace that has not
 * allowed it, or an account that must turn it on in ChatGPT's settings.
 */
import type { LoginCapture, LoginContext, LoginDriver, LoginPrompt } from '../types'
import { codexAuthMetadata, jwtExpiry, parseCodexAuthJson } from './auth-json'

/** The device-code page Codex prints. Only a URL on OpenAI's own sign-in host is relayed. */
export const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device'

/** The scratch directory of one login. `loginId` is a UUID (the route made it). */
export function codexLoginDir(loginId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(loginId)) throw new Error('codexLoginDir: invalid login id')
  return `/tmp/launch-login-${loginId}`
}

/** The scratch `config.toml`: the credential in a file, nothing phoning home. */
export const CODEX_LOGIN_CONFIG = [
  'cli_auth_credentials_store = "file"',
  'check_for_update_on_startup = false',
  '',
  '[analytics]',
  'enabled = false',
  '',
  '[feedback]',
  'enabled = false',
  '',
  '[otel]',
  'metrics_exporter = "none"',
  '',
].join('\n')

/** The runner: the CLI's streams to files, and its exit code written atomically when it ends. */
export function codexLoginScript(dir: string): string {
  return [
    '#!/bin/bash',
    `export CODEX_HOME=${dir}/home HOME=/root NO_COLOR=1`,
    `codex login --device-auth > ${dir}/out 2> ${dir}/err < /dev/null`,
    `echo $? > ${dir}/exit.tmp && mv ${dir}/exit.tmp ${dir}/exit`,
    '',
  ].join('\n')
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what is stripped
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** `text` without colour codes and carriage returns. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '')
}

/** The URL and code in what the CLI printed so far, or null until both are there. */
export function parseCodexDevicePrompt(output: string): LoginPrompt | null {
  const text = stripAnsi(output)
  const url = /https:\/\/auth\.openai\.com\/codex\/device\b[^\s]*/.exec(text)?.[0] ?? null
  const lines = text.split('\n')
  const at = lines.findIndex(line => /one-time code/i.test(line))
  if (!url || at < 0) return null
  const code = lines
    .slice(at + 1)
    .map(line => line.trim())
    .find(Boolean)
  if (!code || !/^[A-Z0-9][A-Z0-9-]{3,31}$/i.test(code)) return null
  return { verificationUrl: url, userCode: code }
}

/** A sentence for a CLI that failed, from its stderr — never its raw output beyond a short reason. */
export function codexLoginFailure(stderr: string, exitCode: number | null): string {
  const text = stripAnsi(stderr)
  if (/device code login is not enabled/i.test(text)) {
    return 'Device-code sign-in is not enabled for this ChatGPT account. Turn it on in ChatGPT’s security settings, or ask your workspace admin to allow it, then try again.'
  }
  if (/timed out/i.test(text)) return 'The sign-in took too long and was stopped. Start it again.'
  const reason = /Error logging in with device code:\s*(.+)/.exec(text)?.[1]?.trim()
  return reason
    ? `Codex could not sign in: ${reason.slice(0, 200)}`
    : `Codex could not sign in (exit code ${exitCode ?? 'unknown'}).`
}

async function readExit(ctx: LoginContext, dir: string): Promise<number | null | undefined> {
  const text = await ctx.sandbox.readFile(`${dir}/exit`)
  if (text === null) return undefined
  const code = Number.parseInt(text.trim(), 10)
  return Number.isFinite(code) ? code : null
}

export const codexLoginDriver: LoginDriver = {
  hosts: ['auth.openai.com'],
  needsCode: false,

  async start(ctx) {
    const dir = codexLoginDir(ctx.loginId)
    await ctx.sandbox.writeFile(`${dir}/home/config.toml`, CODEX_LOGIN_CONFIG)
    await ctx.sandbox.writeFile(`${dir}/run.sh`, codexLoginScript(dir))
    await ctx.sandbox.startProcess(`bash ${dir}/run.sh`)
  },

  async readPrompt(ctx) {
    const dir = codexLoginDir(ctx.loginId)
    const prompt = parseCodexDevicePrompt((await ctx.sandbox.readFile(`${dir}/out`)) ?? '')
    if (prompt) return prompt
    const exit = await readExit(ctx, dir)
    if (exit !== undefined) {
      throw new Error(codexLoginFailure((await ctx.sandbox.readFile(`${dir}/err`)) ?? '', exit))
    }
    return null
  },

  async poll(ctx) {
    const exit = await readExit(ctx, codexLoginDir(ctx.loginId))
    return exit === undefined ? { state: 'running' } : { state: 'exited', exitCode: exit }
  },

  async capture(ctx): Promise<LoginCapture> {
    const dir = codexLoginDir(ctx.loginId)
    const exit = await readExit(ctx, dir)
    if (exit !== 0) {
      throw new Error(
        codexLoginFailure((await ctx.sandbox.readFile(`${dir}/err`)) ?? '', exit ?? null)
      )
    }
    const auth = parseCodexAuthJson(await ctx.sandbox.readFile(`${dir}/home/auth.json`))
    if (!auth) throw new Error('Codex finished but left no ChatGPT sign-in behind.')
    return {
      kind: 'codex_chatgpt_auth',
      secret: JSON.stringify(auth, null, 2),
      // The refresh token outlives the access token; Launch learns it is dead when OpenAI says so.
      expiresAt: null,
      metadata: {
        ...(await codexAuthMetadata(auth)),
        accessExpiresAt: jwtExpiry(auth.tokens.access_token)?.toISOString() ?? null,
      },
    }
  },

  async discard(ctx) {
    // The credential leaves the sandbox once sealed (which `cleanup` destroys anyway).
    await ctx.sandbox
      .exec(`rm -rf ${codexLoginDir(ctx.loginId)}`, { timeoutMs: 15_000 })
      .catch(() => {})
  },
}
