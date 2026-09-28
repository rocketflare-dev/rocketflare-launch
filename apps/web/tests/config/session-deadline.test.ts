/**
 * "Never hang silently" (Launch P3, the hola-world stall): the pure pieces — every bounded sandbox
 * call fails with a sentence that names the step and the call, the port poller gives up the moment
 * the dev server's process is gone, and a failed command's error carries its own output (the tail,
 * scrubbed of the database URI).
 */
import { describe, expect, it } from 'vitest'
import {
  boundedSandbox,
  commandName,
  SESSION_CALL_LIMITS,
  SessionStepTimeoutError,
  withDeadline,
} from '@/api/services/sessions/deadline'
import { SandboxProcessExitedError } from '@/api/services/sessions/ports'
import {
  BOOTSTRAP_LOCK,
  DEV_LOG_FILE,
  DEV_PID_FILE,
  DEV_START_COMMAND,
  INSTALL_COMMAND,
  SessionBootstrapError,
  serialised,
  sessionBootstrap,
  startDevServer,
  tailOf,
} from '@/api/services/sessions/rocketflare-dev'
import {
  PROCESS_EXITED_CODE,
  waitForPortScript,
} from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import { FakeSandbox } from '../helpers/fake-sandbox'

const fast = { ...SESSION_CALL_LIMITS, controlMs: 20, execGraceMs: 20, execMaxMs: 40 }
const dev = { previewOrigin: null, previewHostSuffix: null }
const DB_URI =
  'postgresql://session_owner:s3cret-pw@ep-wild-silence-b1l2mikc.eu-central-1.aws.neon.tech/session_app?sslmode=require'

describe('withDeadline', () => {
  it('answers with the work when it is in time, and a readable timeout when it is not', async () => {
    await expect(withDeadline('fast', 50, Promise.resolve(7))).resolves.toBe(7)
    const never = new Promise<never>(() => {})
    const err = await withDeadline('Starting sandbox: the sandbox (start)', 20, never).catch(e => e)
    expect(err).toBeInstanceOf(SessionStepTimeoutError)
    expect(err.message).toBe('Starting sandbox: the sandbox (start) did not answer within 0.02 s')
    await expect(withDeadline('x', 240_000, Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    )
  })
})

describe('boundedSandbox', () => {
  it('a setAllowedHosts that never answers fails the step, naming it', async () => {
    const fake = new FakeSandbox({ name: 's-hang' }).hangNext('setAllowedHosts')
    const sandbox = boundedSandbox(fake, "Preparing the app's database (first session only)", fast)
    await expect(sandbox.setAllowedHosts(['a.example'])).rejects.toThrow(
      "Preparing the app's database (first session only): the sandbox (setAllowedHosts) did not answer within 0.02 s"
    )
    // The next call is not affected.
    await sandbox.setAllowedHosts(['b.example'])
    expect(fake.allowedHosts).toEqual(['b.example'])
  })

  it('an exec that never answers is bounded by its own timeout plus a grace, capped', async () => {
    const fake = new FakeSandbox({ name: 's-exec' }).hangNext('exec')
    const sandbox = boundedSandbox(fake, 'Installing and seeding', fast)
    await expect(sandbox.exec('pnpm install --frozen-lockfile', { timeoutMs: 10 })).rejects.toThrow(
      /Installing and seeding: the sandbox \(exec pnpm install\) did not answer within 0\.03 s/
    )
    // A long command's own timeout is capped at `execMaxMs`.
    fake.hangNext('exec')
    await expect(sandbox.exec('sleep 1000', { timeoutMs: 10 * 60_000 })).rejects.toThrow(
      /did not answer within 0\.04 s/
    )
  })

  it('names the command a stuck exec was running, past the lock wrapper', () => {
    expect(commandName(serialised(INSTALL_COMMAND, 600_000))).toBe('pnpm install')
    expect(commandName('node --import x scripts/bootstrap.mjs')).toBe('node --import')
  })

  it('passes a turn’s log stream and the preview through untouched', async () => {
    const fake = new FakeSandbox({ name: 's-pass' }).onPort(5173, () => new Response('app'))
    const sandbox = boundedSandbox(fake, undefined, fast)
    expect(sandbox.name).toBe('s-pass')
    expect(sandbox.id).toBe(fake.id)
    expect(await (await sandbox.fetch(5173, new Request('http://x/'))).text()).toBe('app')
  })
})

describe('the dev server wait', () => {
  it('the port poller checks the dev server’s pid and exits 3 when it is gone', () => {
    const script = waitForPortScript(8787, {
      path: '/api/health',
      timeoutMs: 20_000,
      pidFile: DEV_PID_FILE,
    })
    expect(script).toContain(`kill -0 "$pid"`)
    expect(script).toContain(`exit ${PROCESS_EXITED_CODE}`)
    expect(script).toContain('seq 1 40')
    expect(waitForPortScript(5173)).not.toContain('kill -0')
  })

  it('starts pnpm dev with its pid and its log in files', () => {
    expect(DEV_START_COMMAND).toBe(
      `mkdir -p /workspace/.launch && echo $$ > ${DEV_PID_FILE} && exec pnpm dev > ${DEV_LOG_FILE} 2>&1`
    )
  })

  it('a dev server that exits fails at once with the tail of its own output', async () => {
    const fake = new FakeSandbox({ name: 's-dev' }).onProcess(/pnpm dev/, {
      lines: ['boom'],
      exitCode: 1,
    })
    fake.files.set(DEV_LOG_FILE, 'vite v6\nError: Cannot find module "workerd"\n')
    const started = Date.now()
    const err = await startDevServer(fake, dev).catch(e => e)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.message).toContain('the dev server exited before its ports answered')
    expect(err.message).toContain('Cannot find module "workerd"')
  })

  it('stops waiting between chunks when the checkpoint says so', async () => {
    const fake = new FakeSandbox({ name: 's-stop' }).onProcess(/pnpm dev/, {
      lines: [],
      hang: true,
    })
    let calls = 0
    const err = await startDevServer(fake, dev, {
      chunkMs: 1,
      checkpoint: async () => {
        calls += 1
        if (calls > 2) throw new Error('ended')
      },
    }).catch(e => e)
    expect(err.message).toBe('ended')
    expect(calls).toBe(3)
  })

  it('SandboxProcessExitedError is the port’s own error, not a string', () => {
    expect(new SandboxProcessExitedError('x').name).toBe('SandboxProcessExitedError')
  })
})

describe('a failed command says what it printed', () => {
  it('keeps the last 40 lines of stdout and stderr, headline first, the database URI scrubbed', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`)
    const text = [
      '✖ 2/10 install  pnpm install failed',
      ...lines,
      `connecting to ${DB_URI}`,
      '\u001b[31mERR_PNPM_LOCKFILE\u001b[39m frozen lockfile out of date',
    ].join('\n')
    const tail = tailOf(text, [DB_URI])
    expect(tail.split('\n')[0]).toBe('✖ 2/10 install  pnpm install failed')
    expect(tail).toContain('line 80')
    expect(tail).not.toContain('line 30\n')
    expect(tail).toContain('ERR_PNPM_LOCKFILE frozen lockfile out of date')
    expect(tail).not.toContain('s3cret-pw')
    expect(tail).toContain('connecting to <database url>')
  })

  it('sessionBootstrap puts the install’s output in its error, and serialises the two commands', async () => {
    const fake = new FakeSandbox({ name: 's-boot' }).onExec(/pnpm install/, {
      exitCode: 1,
      stdout: 'Progress: resolved 1\n',
      stderr: ` ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: Not Found\nwhile using ${DB_URI}\n`,
    })
    const err = await sessionBootstrap({ sandbox: fake, dbUri: DB_URI, dev }).catch(e => e)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.message).toContain('ERR_PNPM_FETCH_404')
    expect(err.message).not.toContain('s3cret-pw')
    expect(fake.execs[0]?.command).toBe(serialised(INSTALL_COMMAND, 10 * 60_000))
    expect(fake.execs[0]?.command).toContain(`flock -w 600 ${BOOTSTRAP_LOCK} pnpm install`)
  })
})
