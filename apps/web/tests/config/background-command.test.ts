/**
 * A long command in a session's container, in the background and polled
 * (`services/sessions/background-command.ts`), and the kit bootstrap on top of it
 * (`rocketflare-dev.ts` `sessionBootstrap`). Against `FakeSandbox`, which speaks the runner's file
 * protocol; the runner script itself runs under a real bash where `setsid` exists (Linux, CI).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_FAST_POLL_MS,
  BACKGROUND_FAST_WINDOW_MS,
  BACKGROUND_MID_POLL_MS,
  BACKGROUND_MID_WINDOW_MS,
  BACKGROUND_POLL_MS,
  BackgroundCommandAbortedError,
  BackgroundCommandLostError,
  BackgroundCommandTimeoutError,
  backgroundPollInterval,
  backgroundRunnerScript,
  killGroupCommand,
  LIVENESS_EVERY_POLLS,
  lastMeaningfulLine,
  runInBackground,
} from '@/api/services/sessions/background-command'
import {
  BOOTSTRAP_PROGRESS,
  bootstrapProgressOf,
  INSTALL_PROGRESS,
  SESSION_LAUNCH_DIR,
  SessionBootstrapError,
  sessionBootstrap,
} from '@/api/services/sessions/rocketflare-dev'
import { FakeSandbox } from '../helpers/fake-sandbox'

const DIR = SESSION_LAUNCH_DIR
const DB_URI =
  'postgresql://session_owner:s3cret-pw@ep-x-000001.us-east-2.aws.neon.tech/session_app?sslmode=require'
const dev = { previewOrigin: null, previewHostSuffix: null }
const noSleep = async () => {}
const base = { dir: DIR, timeoutMs: 60_000, pollMs: 1, sleep: noSleep }

describe('runInBackground', () => {
  it('starts the command in the background and returns its exit code and output', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm install/, { log: 'done\n', exitCode: 0 })
    const result = await runInBackground(fake, {
      ...base,
      name: 'install',
      command: 'pnpm install',
      cwd: '/workspace/app',
      env: { SECRET_URL: 'postgresql://u:pw@h/db' },
    })
    expect(result).toEqual({ exitCode: 0, stdout: 'done\n', attached: false })
    // Never a blocking exec of the command itself; the environment stays off the command line.
    expect(fake.execs).toEqual([])
    expect(fake.backgroundRuns).toHaveLength(1)
    const [run] = fake.backgroundRuns
    expect(run?.opts).toEqual({
      cwd: '/workspace/app',
      env: { SECRET_URL: 'postgresql://u:pw@h/db' },
    })
    expect(run?.command).not.toContain('pw@')
    expect(fake.files.get(`${DIR}/install.exit`)).toBe(`${run?.runId} 0\n`)
  })

  it('polls every 0.5 s for its first 30 s, every 1 s to 2 min, then every 2.5 s', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm install/, { hang: true })
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const slept: number[] = []
    try {
      await runInBackground(fake, {
        ...base,
        timeoutMs: 10 * 60_000,
        pollMs: BACKGROUND_POLL_MS,
        name: 'install',
        command: 'pnpm install',
        sleep: async ms => {
          slept.push(ms)
          clock += ms
          if (clock - 1_000_000 >= 125_000) fake.finishBackground('install', { exitCode: 0 })
        },
      })
    } finally {
      now.mockRestore()
    }
    const fast = BACKGROUND_FAST_WINDOW_MS / BACKGROUND_FAST_POLL_MS
    const mid = (BACKGROUND_MID_WINDOW_MS - BACKGROUND_FAST_WINDOW_MS) / BACKGROUND_MID_POLL_MS
    expect(slept.slice(0, fast)).toEqual(Array(fast).fill(BACKGROUND_FAST_POLL_MS))
    expect(slept.slice(fast, fast + mid)).toEqual(Array(mid).fill(BACKGROUND_MID_POLL_MS))
    expect(slept.slice(fast + mid)).toEqual([BACKGROUND_POLL_MS, BACKGROUND_POLL_MS])
    // A boot's 20-25 s install or bootstrap ends inside the half-second window.
    expect(BACKGROUND_FAST_WINDOW_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('the schedule: 0.5 s, then 1 s, then pollMs — never longer than pollMs', () => {
    expect(backgroundPollInterval(0, 2_500)).toBe(500)
    expect(backgroundPollInterval(29_999, 2_500)).toBe(500)
    expect(backgroundPollInterval(30_000, 2_500)).toBe(1_000)
    expect(backgroundPollInterval(119_999, 2_500)).toBe(1_000)
    expect(backgroundPollInterval(120_000, 2_500)).toBe(2_500)
    expect(backgroundPollInterval(60_000, 700)).toBe(700)
    expect(backgroundPollInterval(0, 1)).toBe(1)
  })

  it('a poll interval already shorter than the fast one is kept', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm install/, { hang: true })
    const slept: number[] = []
    await runInBackground(fake, {
      ...base,
      pollMs: 100,
      name: 'install',
      command: 'pnpm install',
      sleep: async ms => {
        slept.push(ms)
        fake.finishBackground('install', { exitCode: 0 })
      },
    })
    expect(slept).toEqual([100])
  })

  it('a non-zero exit is a result, not a throw', async () => {
    const fake = new FakeSandbox().onBackground('false', { log: 'nope\n', exitCode: 2 })
    const result = await runInBackground(fake, { ...base, name: 'x', command: 'false' })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('nope\n')
  })

  it('past its deadline the process group is killed and the log comes back in the error', async () => {
    const fake = new FakeSandbox().onBackground('sleep', { hang: true, log: 'still going\n' })
    const err = await runInBackground(fake, {
      ...base,
      name: 'slow',
      command: 'sleep 999',
      timeoutMs: 20,
      pollMs: 2,
      sleep: undefined,
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandTimeoutError)
    expect(err.message).toBe('slow did not finish within 0.02 s')
    expect(err.log).toBe('still going\n')
    const [run] = fake.backgroundRuns
    expect(run).toMatchObject({ killed: true, exitCode: 143 })
    expect(fake.commands.at(-1)).toBe(killGroupCommand(run?.pid ?? 0))
  })

  it('a step retry ATTACHES to the run an earlier attempt left going — never a second copy', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm install/, { hang: true })
    // Attempt 1 dies after its first poll (the step's RPC dropped); the install keeps running.
    const dropped = new Error('Peer closed WebSocket: 1006')
    const first = await runInBackground(fake, {
      ...base,
      name: 'install',
      command: 'pnpm install',
      sleep: async () => {
        throw dropped
      },
    }).catch(e => e)
    expect(first).toBe(dropped)
    // Attempt 2: the same run, polled until it finishes.
    const second = await runInBackground(fake, {
      ...base,
      name: 'install',
      command: 'pnpm install',
      sleep: async () => {
        fake.finishBackground('install', { exitCode: 0, log: 'installed\n' })
      },
    })
    expect(second).toEqual({ exitCode: 0, stdout: 'installed\n', attached: true })
    expect(fake.backgroundRuns).toHaveLength(1)
  })

  it('a LAZY env is minted only when a run starts — never when a retry attaches', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm test/, { hang: true })
    let minted = 0
    const env = async () => {
      minted++
      return { DATABASE_URL: `postgresql://u:pw${minted}@h/db` }
    }
    const dropped = new Error('Peer closed WebSocket: 1006')
    await runInBackground(fake, {
      ...base,
      name: 'gate-test',
      command: 'pnpm test',
      env,
      sleep: async () => {
        throw dropped
      },
    }).catch(() => {})
    const second = await runInBackground(fake, {
      ...base,
      name: 'gate-test',
      command: 'pnpm test',
      env,
      sleep: async () => {
        fake.finishBackground('gate-test', { exitCode: 0 })
      },
    })
    expect(second.attached).toBe(true)
    // One password for one run: the attached retry never reset it under the running suite.
    expect(minted).toBe(1)
    expect(fake.backgroundRuns[0]?.opts?.env).toEqual({ DATABASE_URL: 'postgresql://u:pw1@h/db' })
  })

  it('an aborted signal kills the process group at the next poll and says so', async () => {
    const fake = new FakeSandbox().onBackground(/pnpm test/, { hang: true, log: 'running…\n' })
    const controller = new AbortController()
    let polls = 0
    const err = await runInBackground(fake, {
      ...base,
      name: 'gate-test',
      command: 'pnpm test',
      signal: controller.signal,
      sleep: async () => {
        if (++polls === 2) controller.abort()
      },
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandAbortedError)
    expect((err as BackgroundCommandAbortedError).log).toContain('running…')
    expect(fake.backgroundRuns[0]?.killed).toBe(true)
  })

  it('a FINISHED earlier run is never reused: the same name runs again (another database)', async () => {
    const fake = new FakeSandbox()
      .onBackground(/--db dev/, { log: 'dev\n' })
      .onBackground(/--db branch/, { log: 'branch\n' })
    await runInBackground(fake, { ...base, name: 'bootstrap', command: 'boot --db dev' })
    const again = await runInBackground(fake, {
      ...base,
      name: 'bootstrap',
      command: 'boot --db branch',
    })
    expect(again).toEqual({ exitCode: 0, stdout: 'branch\n', attached: false })
    expect(fake.backgroundRuns).toHaveLength(2)
  })

  it('a dead run with no exit code is not attached to: it starts fresh', async () => {
    const fake = new FakeSandbox()
    // A pid file left by a run whose process is gone (fake pid 1 is nobody's).
    fake.files.set(`${DIR}/install.pid`, '1 oldrun\n')
    const result = await runInBackground(fake, { ...base, name: 'install', command: 'pnpm i' })
    expect(result.attached).toBe(false)
    expect(fake.backgroundRuns).toHaveLength(1)
  })

  it('calls onProgress only when the progress CHANGES', async () => {
    const fake = new FakeSandbox().onBackground('boot', {
      log: ['a\n', '\n', 'b\n', '   \n', 'b\n', 'c\n'],
    })
    const seen: string[] = []
    const result = await runInBackground(fake, {
      ...base,
      name: 'boot',
      command: 'boot',
      onProgress: line => void seen.push(line),
    })
    expect(result.stdout).toBe('a\n\nb\n   \nb\nc\n')
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('a failing onProgress never fails the command', async () => {
    const fake = new FakeSandbox().onBackground('x', { log: ['1\n', '2\n'] })
    const result = await runInBackground(fake, {
      ...base,
      name: 'x',
      command: 'x',
      onProgress: () => {
        throw new Error('the event log is down')
      },
    })
    expect(result.exitCode).toBe(0)
  })

  it('one failed poll is retried; three in a row give up', async () => {
    const fake = new FakeSandbox().onBackground('x', { log: ['1\n', '2\n'] })
    let polls = 0
    const ok = await runInBackground(fake, {
      ...base,
      name: 'x',
      command: 'x',
      sleep: async () => {
        if (++polls === 1) fake.failNext('readFile', new Error('Peer closed WebSocket: 1006'))
      },
    })
    expect(ok.exitCode).toBe(0)

    const stuck = new FakeSandbox().onBackground('y', { hang: true })
    const err = await runInBackground(stuck, {
      ...base,
      name: 'y',
      command: 'y',
      sleep: async () => {
        stuck.failNext('readFile', new Error('Peer closed WebSocket: 1006'))
      },
    }).catch(e => e)
    expect(err.message).toBe('Peer closed WebSocket: 1006')
  })

  it('a container replaced under the run: its files are gone, and it says so', async () => {
    const fake = new FakeSandbox().onBackground('x', { hang: true })
    const err = await runInBackground(fake, {
      ...base,
      name: 'x',
      command: 'x',
      sleep: async () => {
        fake.recreate()
      },
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandLostError)
    expect(err.message).toMatch(/files are gone/)
  })

  it('a container replaced before the first poll: the log Launch wrote is gone, so it fails at once — even for a command that printed nothing', async () => {
    const fake = new FakeSandbox().onBackground('x', { hang: true })
    const start = fake.startProcess.bind(fake)
    fake.startProcess = async (command, opts) => {
      const proc = await start(command, opts)
      fake.recreate()
      return proc
    }
    let polls = 0
    const err = await runInBackground(fake, {
      ...base,
      timeoutMs: 2_000,
      name: 'x',
      command: 'x',
      sleep: async () => {
        polls++
      },
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandLostError)
    expect(err.message).toMatch(/files are gone/)
    expect(polls).toBe(0)
  })

  it('a replaced container whose calls fail: the boot-marker probe ends the wait at the first failed poll', async () => {
    const fake = new FakeSandbox().onBackground('x', { hang: true })
    const probes: number[] = []
    let polls = 0
    const err = await runInBackground(fake, {
      ...base,
      timeoutMs: 2_000,
      name: 'x',
      command: 'x',
      sleep: async () => {
        polls++
        // The platform is bringing a new container up under the old run's id.
        fake.failNext('readFile', new Error('HTTP error! status: 500'))
      },
      replaced: async () => {
        probes.push(polls)
        return true
      },
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandLostError)
    expect(err.message).toMatch(/container was replaced under it/)
    // One good poll, one failed one, then the probe — not MAX_POLL_FAILURES of them, nor the deadline.
    expect(probes).toEqual([1])
    expect(fake.backgroundRuns[0]?.killed).toBe(false)
  })

  it('a replaced container that still answers: the probe with the liveness check notices it', async () => {
    const fake = new FakeSandbox().onBackground('x', { hang: true })
    let polls = 0
    let asked = 0
    const err = await runInBackground(fake, {
      ...base,
      timeoutMs: 5_000,
      name: 'x',
      command: 'x',
      sleep: async () => {
        polls++
      },
      replaced: async () => {
        asked++
        return polls >= LIVENESS_EVERY_POLLS * 2 - 1
      },
    }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandLostError)
    expect(err.message).toMatch(/container was replaced under it/)
    // Asked only with the liveness checks: the second one says replaced.
    expect(asked).toBe(2)
    expect(polls).toBe(LIVENESS_EVERY_POLLS * 2 - 1)
  })

  it('a probe that fails is no evidence: the run goes on and finishes', async () => {
    const fake = new FakeSandbox().onBackground('x', {
      log: Array.from({ length: LIVENESS_EVERY_POLLS + 2 }, (_, i) => `line ${i}\n`),
    })
    let asked = 0
    const result = await runInBackground(fake, {
      ...base,
      name: 'x',
      command: 'x',
      replaced: async () => {
        asked++
        throw new Error('no answer within 15000 ms')
      },
    })
    expect(result.exitCode).toBe(0)
    expect(asked).toBe(1)
  })

  it('a runner that died without an exit code is noticed by the liveness check', async () => {
    const fake = new FakeSandbox().onBackground('x', () => Promise.reject(new Error('runner died')))
    const err = await runInBackground(fake, { ...base, name: 'x', command: 'x' }).catch(e => e)
    expect(err).toBeInstanceOf(BackgroundCommandLostError)
    expect(err.message).toMatch(/stopped without recording an exit code/)
    expect(fake.commands.filter(c => c.startsWith('kill -0 '))).toHaveLength(1)
    expect(LIVENESS_EVERY_POLLS).toBeGreaterThan(1)
  })

  it('refuses a name or directory that could break out of the shell', async () => {
    const fake = new FakeSandbox()
    await expect(
      runInBackground(fake, { ...base, name: 'x; rm -rf /', command: 'x' })
    ).rejects.toThrow(/unsafe name/)
    await expect(
      runInBackground(fake, { ...base, dir: '/tmp/$(id)', name: 'x', command: 'x' })
    ).rejects.toThrow(/unsafe dir/)
  })

  it('lastMeaningfulLine: the last non-blank line, colours stripped', () => {
    expect(lastMeaningfulLine('a\n\u001b[32mb\u001b[39m\n  \n')).toBe('b')
    expect(lastMeaningfulLine('\n \n')).toBeNull()
  })
})

describe('the kit bootstrap in the background', () => {
  it('bootstrapProgressOf: the latest ✔/✖ n/10 line, as mark, count and name only', () => {
    const log = [
      '\u001b[32m✔\u001b[39m 1/10 toolchain  node 24',
      '  note: something',
      '✔ 4/10 database   ep-x-000001.us-east-2.aws.neon.tech reachable',
      'child output',
    ].join('\n')
    expect(bootstrapProgressOf(log)).toBe('✔ 4/10 database')
    expect(bootstrapProgressOf('✖ 5/10 migrate    relation exists')).toBe('✖ 5/10 migrate')
    expect(bootstrapProgressOf('no steps yet')).toBeNull()
  })

  it('reports the running step’s detail on change: the install, then each ✔ n/10 line', async () => {
    const fake = new FakeSandbox().onBackground(/scripts\/bootstrap\.mjs/, {
      log: [
        '✔ 1/10 toolchain  ok\n',
        '  a note\n',
        '✔ 2/10 install    ok\n',
        `✔ 3/10 secrets    ${DB_URI}\n`,
        '✔ 4/10 database   ok\n',
      ],
    })
    const details: string[] = []
    await sessionBootstrap({
      sandbox: fake,
      dbUri: DB_URI,
      dev,
      pollMs: 1,
      sleep: noSleep,
      onProgress: detail => void details.push(detail),
    })
    expect(details).toEqual([
      INSTALL_PROGRESS,
      BOOTSTRAP_PROGRESS,
      '✔ 1/10 toolchain',
      '✔ 2/10 install',
      '✔ 3/10 secrets',
      '✔ 4/10 database',
    ])
    expect(details.join('\n')).not.toContain('s3cret-pw')
  })

  it('a failed bootstrap keeps its error: the ✖ line first, the database URI scrubbed', async () => {
    const fake = new FakeSandbox().onBackground(/scripts\/bootstrap\.mjs/, {
      exitCode: 1,
      log: `✔ 4/10 database ok\n✖ 5/10 migrate   relation "users" already exists\n  at ${DB_URI}\n`,
    })
    const err = await sessionBootstrap({ sandbox: fake, dbUri: DB_URI, dev }).catch(e => e)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.phase).toBe('bootstrap')
    expect(err.message.split('\n').slice(0, 2)).toEqual([
      "The app's bootstrap failed (exit 1):",
      '✖ 5/10 migrate   relation "users" already exists',
    ])
    expect(err.message).toContain('at <database url>')
    expect(err.message).not.toContain('s3cret-pw')
  })

  it('a bootstrap past its deadline is killed; the error carries its redacted tail', async () => {
    const fake = new FakeSandbox().onBackground(/scripts\/bootstrap\.mjs/, {
      hang: true,
      log: `✔ 4/10 database ok\nwaiting for ${DB_URI}\n`,
    })
    const err = await sessionBootstrap({
      sandbox: fake,
      dbUri: DB_URI,
      dev,
      pollMs: 2,
      maxCommandMs: 30,
    }).catch(e => e)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.phase).toBe('bootstrap')
    expect(err.message).toBe(
      "The app's bootstrap did not finish within 0.03 s; Launch stopped it:\n✔ 4/10 database ok\nwaiting for <database url>"
    )
    expect(fake.backgroundRuns.at(-1)).toMatchObject({ name: 'bootstrap', killed: true })
  })
})

// ---- the runner script under a real shell (needs `setsid`: Linux, as in the container) ---------

const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0

describe.skipIf(!hasSetsid)('the runner script under bash', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('records the pid and the run id, keeps stdout and stderr in the log, and the exit code', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bg-'))
    const script = backgroundRunnerScript({
      dir,
      name: 'job',
      runId: 'run1',
      command: 'echo out; echo err >&2; echo "$SECRET"; exit 3',
    })
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, SECRET: 'from-env' },
    })
    expect(result.status).toBe(0)
    expect(readFileSync(`${dir}/job.exit`, 'utf8')).toBe('run1 3\n')
    expect(readFileSync(`${dir}/job.log`, 'utf8')).toBe('out\nerr\nfrom-env\n')
    expect(readFileSync(`${dir}/job.pid`, 'utf8')).toMatch(/^\d+ run1\n$/)
  })

  it('the group kill stops the command and its children; the runner still records the exit', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bg-'))
    const script = backgroundRunnerScript({
      dir,
      name: 'job',
      runId: 'run2',
      command: 'sleep 60 & sleep 60; wait',
    })
    const runner = spawn('bash', ['-c', script], { stdio: 'ignore' })
    const exited = new Promise<void>(resolve => runner.on('exit', () => resolve()))
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      try {
        pid = Number(readFileSync(`${dir}/job.pid`, 'utf8').split(' ')[0])
      } catch {}
    }
    expect(pid).toBeGreaterThan(0)
    const kill = spawnSync('bash', ['-c', killGroupCommand(pid, 1)], { encoding: 'utf8' })
    expect(kill.status).toBe(0)
    await exited
    expect(readFileSync(`${dir}/job.exit`, 'utf8')).toMatch(/^run2 (143|137)\n$/)
    expect(spawnSync('bash', ['-c', `kill -0 -- -${pid}`]).status).not.toBe(0)
  })
})
