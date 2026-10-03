/**
 * Claude's relayed sign-in in tests (§18.22-A): the spike S-A1 terminal fixtures
 * (`tests/fixtures/claude-login/*.ansi` — real `claude setup-token` output from Claude Code 2.1.283
 * under `script`; `<<<SPIKE: …>>>` lines mark what the spike typed), a SYNTHETIC success screen
 * (the spike stopped before a real exchange: the sentences and token shape are what the CLI
 * prints, laid out with the same cursor moves), and `emulateClaudeRelay` — the `script` half of
 * the relay over a `FakeSandbox`, so the real driver can be driven end to end.
 */
import { readFileSync } from 'node:fs'
import {
  CLAUDE_LOGIN_ROOT,
  claudeLoginDir,
} from '@/api/services/sessions/runtimes/claude-code/login'
import type { FakeSandbox } from './fake-sandbox'

export function claudeLoginFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/claude-login/${name}`, import.meta.url), 'utf8')
}

/** A fixture cut at the spike's annotations: [before the first input, after it, …]. */
export function spikeSegments(raw: string): string[] {
  return raw.split(/\n?<<<SPIKE:[^>]*>>>\n?/)
}

/** A token-shaped value no real account has. */
export const FAKE_CLAUDE_TOKEN = `sk-ant-oat01-${'Qx7_'.repeat(20)}fakeTokenAA`

/** What setup-token prints after a good code (synthetic — see the header). */
export function setupTokenSuccessScreen(token: string = FAKE_CLAUDE_TOKEN): string {
  return [
    '\u001b(B\u001b[?2004h\u001b[2K\u001b[1A\u001b[2K\u001b[G',
    '\u001b[2G\u001b[38;5;114m✓\u001b[4G\u001b[39mLong-lived\u001b[15Gauthentication\u001b[30Gtoken\u001b[36Gcreated\u001b[44Gsuccessfully!\r\r\n',
    '\r\r\n',
    '\u001b[2GYour\u001b[7GOAuth\u001b[13Gtoken\u001b[19G(valid\u001b[26Gfor\u001b[30G1\u001b[32Gyear):\r\r\n',
    '\r\r\n',
    `\u001b[2G\u001b[38;5;231m${token}\u001b[39m\r\r\n`,
    '\r\r\n',
    '\u001b[2G\u001b[38;5;246mStore\u001b[8Gthis\u001b[13Gtoken\u001b[19Gsecurely.\u001b[39m\r\r\n',
  ].join('')
}

/**
 * Make `sandbox` behave like the relay's `script` for every `claude setup-token` it starts: what
 * the process "prints" (its `onProcess` script) is appended to `<dir>/out`, its exit code written
 * to `<dir>/exit`; and `rm -rf <dir>` really removes the files. Script the CLI itself with
 * `onProcess(/claude setup-token/, { lines, waitForFile: <dir>/in, thenLines, hang? })`.
 */
export function emulateClaudeRelay(sandbox: FakeSandbox): FakeSandbox {
  const start = sandbox.startProcess.bind(sandbox)
  sandbox.startProcess = async (command, opts) => {
    const proc = await start(command, opts)
    const match = new RegExp(`mkdir -p (${CLAUDE_LOGIN_ROOT}/[A-Za-z0-9-]+) `).exec(command)
    if (match?.[1] && command.includes('claude setup-token')) {
      const dir = match[1]
      void (async () => {
        try {
          for await (const event of sandbox.streamLogs(proc.id)) {
            if (event.type === 'exit') sandbox.files.set(`${dir}/exit`, `${event.exitCode}\n`)
            else
              sandbox.files.set(
                `${dir}/out`,
                `${sandbox.files.get(`${dir}/out`) ?? ''}${event.data}`
              )
          }
        } catch {
          // The sandbox was destroyed under it.
        }
      })()
    }
    return proc
  }
  sandbox.onExec(/^rm -rf /, command => {
    const target = command.slice('rm -rf '.length).trim()
    for (const path of [...sandbox.files.keys()]) {
      if (path === target || path.startsWith(`${target}/`)) sandbox.files.delete(path)
    }
    return {}
  })
  return sandbox
}

export { claudeLoginDir }
