/**
 * "Never hang silently" (Launch P3, the hola-world stall): the pure pieces — every bounded sandbox
 * call fails with a sentence that names the step and the call, the port poller gives up the moment
 * the dev server's process is gone, and a failed command's error carries its own output (the tail,
 * scrubbed of the database URI).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  boundedSandbox,
  commandName,
  SESSION_CALL_LIMITS,
  SessionStepTimeoutError,
  withDeadline,
} from '@/api/services/sessions/deadline'
import { SandboxProcessExitedError } from '@/api/services/sessions/ports'
import { PREBUILD_EXCLUDES } from '@/api/services/sessions/prebuild'
import {
  BOOTSTRAP_LOCK,
  DEV_COMMAND,
  DEV_FALLBACK_COMMAND,
  DEV_GRACEFUL_STOP_COMMAND,
  DEV_HOT_PATHS,
  DEV_LOG_FILE,
  DEV_PID_FILE,
  DEV_READY_PROBE,
  DEV_SERVER_SCRIPT,
  DEV_START_COMMAND,
  DEV_WARM_COMMAND,
  devServerAnswers,
  INSTALL_COMMAND,
  NODE_COMPILE_CACHE_DIR,
  PREREAD_COMMAND,
  prereadHotFiles,
  SESSION_LAUNCH_DIR,
  SESSION_WORKSPACE,
  SessionBootstrapError,
  serialised,
  sessionBootstrap,
  sessionProcessEnv,
  startDevServer,
  stopDevServerGracefully,
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
    expect(script).toContain('end=$((SECONDS + 20))')
    expect(script).toContain('sleep 0.2')
    expect(waitForPortScript(5173)).not.toContain('kill -0')
  })

  it('the dev stack is ONE wait: the API’s health first (a longer curl), then a TCP connect to Vite — never a GET of /', () => {
    const script = waitForPortScript(DEV_READY_PROBE.port, {
      path: DEV_READY_PROBE.path,
      followedBy: DEV_READY_PROBE.followedBy,
      timeoutMs: 20_000,
      pidFile: DEV_PID_FILE,
    })
    const api = script.indexOf("'http://127.0.0.1:8787/api/health'")
    const ui = script.indexOf('/dev/tcp/127.0.0.1/5173')
    expect(api).toBeGreaterThan(-1)
    expect(ui).toBeGreaterThan(api)
    expect(script).toContain('-m 5 ')
    expect(script).not.toContain('http://127.0.0.1:5173')
    // The UI probe runs only in the stage after the API answered.
    expect(script).toContain('if [ $s -eq 1 ] && (: <>/dev/tcp/127.0.0.1/5173)')
  })

  /** {@link waitForPortScript} under a real bash against real sockets on free ports. */
  async function withServers<T>(
    apiStatus: () => number,
    run: (ports: { api: number; ui: number; uiConnections: () => number }) => T
  ): Promise<T> {
    const http = await import('node:http')
    const net = await import('node:net')
    let uiConnections = 0
    const api = http.createServer((_req, res) => res.writeHead(apiStatus()).end())
    const ui = net.createServer(socket => {
      uiConnections += 1
      socket.destroy()
    })
    const listen = (s: { listen: (p: number, h: string, cb: () => void) => void }) =>
      new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
    await listen(api)
    await listen(ui)
    try {
      const port = (s: { address: () => unknown }) => (s.address() as { port: number }).port
      return await run({ api: port(api), ui: port(ui), uiConnections: () => uiConnections })
    } finally {
      api.close()
      ui.close()
    }
  }

  const bashAsync = (script: string) =>
    new Promise<{ status: number | null; stdout: string }>(resolve => {
      import('node:child_process').then(({ execFile }) => {
        execFile('bash', ['-c', script], (err, stdout) =>
          resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout })
        )
      })
    })

  it('under bash: answers once the API is healthy and the UI accepts a connection, and never touches the UI before', async () => {
    let healthy = false
    await withServers(
      () => (healthy ? 200 : 503),
      async ({ api, ui, uiConnections }) => {
        const opts = { path: '/api/health', followedBy: [{ port: ui, tcp: true }], timeoutMs: 1000 }
        // The API answers 503 for the whole wait: out of time on stage 0, the UI never probed.
        const waiting = await bashAsync(waitForPortScript(api, opts))
        expect(waiting.status).toBe(1)
        expect(waiting.stdout.trim()).toBe('waiting=0')
        expect(uiConnections()).toBe(0)
        healthy = true
        const ready = await bashAsync(waitForPortScript(api, { ...opts, timeoutMs: 5000 }))
        expect(ready.status).toBe(0)
        expect(uiConnections()).toBe(1)
      }
    )
  })

  it('under bash: a closed UI port times out on stage 1', async () => {
    await withServers(
      () => 200,
      async ({ api }) => {
        const closed = await bashAsync(
          waitForPortScript(api, {
            path: '/api/health',
            followedBy: [{ port: 1, tcp: true }],
            timeoutMs: 1000,
          })
        )
        expect(closed.status).toBe(1)
        expect(closed.stdout.trim()).toBe('waiting=1')
      }
    )
  })

  it('starts the kit’s dev server directly, the session config its preload, its pid and its log in files', () => {
    expect(DEV_COMMAND).toBe(
      'node --import /workspace/.launch/session-wrangler.mjs apps/web/scripts/dev-server.mjs --start'
    )
    expect(DEV_START_COMMAND).toBe(
      `mkdir -p /workspace/.launch && echo $$ > ${DEV_PID_FILE} && if [ -f apps/web/scripts/dev-server.mjs ]; then exec ${DEV_COMMAND} > ${DEV_LOG_FILE} 2>&1; else node /workspace/.launch/session-wrangler.mjs > ${DEV_LOG_FILE} 2>&1 && exec ${DEV_FALLBACK_COMMAND} >> ${DEV_LOG_FILE} 2>&1; fi`
    )
  })

  /** {@link DEV_START_COMMAND} under a real shell in a stand-in checkout, the launch dir moved. */
  function runDevStart(withScript: boolean) {
    const root = mkdtempSync(path.join(tmpdir(), 'launch-dev-start-'))
    try {
      const launch = path.join(root, 'launch')
      const checkout = path.join(root, 'app')
      const bin = path.join(root, 'bin')
      mkdirSync(path.join(checkout, 'apps/web/scripts'), { recursive: true })
      mkdirSync(bin)
      // A stand-in for the session-config script: the preload of the dev server, or its own node.
      mkdirSync(launch)
      writeFileSync(
        path.join(launch, 'session-wrangler.mjs'),
        "console.log('session-config pid=' + process.pid)\n"
      )
      if (withScript) {
        writeFileSync(
          path.join(checkout, DEV_SERVER_SCRIPT),
          "console.log('dev-server ' + process.argv.slice(2).join(' ') + ' pid=' + process.pid)\n"
        )
      }
      // A stand-in pnpm: what the fallback runs.
      writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $* pid=$$"\n')
      chmodSync(path.join(bin, 'pnpm'), 0o755)
      const command = DEV_START_COMMAND.split(SESSION_LAUNCH_DIR).join(launch)
      const res = spawnSync('sh', ['-c', command], {
        cwd: checkout,
        env: {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      })
      expect(res.status, res.stderr).toBe(0)
      return {
        log: readFileSync(path.join(launch, 'dev.log'), 'utf8').trim(),
        pid: readFileSync(path.join(launch, 'dev.pid'), 'utf8').trim(),
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('runs dev-server.mjs when the checkout has it — the recorded pid is the dev server', () => {
    const { log, pid } = runDevStart(true)
    // The session config is written by the SAME process, first (its `--import` preload).
    expect(log).toBe(`session-config pid=${pid}\ndev-server --start pid=${pid}`)
  })

  it('falls back to pnpm dev when the checkout has no dev-server.mjs', () => {
    const { log, pid } = runDevStart(false)
    const [config, dev] = log.split('\n')
    expect(config).toMatch(/^session-config pid=\d+$/)
    expect(dev).toBe(`pnpm dev pid=${pid}`)
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
    const fake = new FakeSandbox({ name: 's-boot' }).onBackground(/pnpm install/, {
      exitCode: 1,
      log: `Progress: resolved 1\n ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: Not Found\nwhile using ${DB_URI}\n`,
    })
    const err = await sessionBootstrap({ sandbox: fake, dbUri: DB_URI, dev }).catch(e => e)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.phase).toBe('install')
    expect(err.message).toMatch(/^pnpm install failed \(exit 1\):\n/)
    expect(err.message).toContain('ERR_PNPM_FETCH_404')
    expect(err.message).not.toContain('s3cret-pw')
    expect(err.message).toContain('while using <database url>')
    // In the background, under the lock — never a blocking exec.
    expect(fake.execs.filter(e => /pnpm install/.test(e.command))).toEqual([])
    expect(fake.backgroundRuns[0]?.command).toContain(serialised(INSTALL_COMMAND, 10 * 60_000))
    expect(fake.backgroundRuns[0]?.command).toContain(`flock -w 600 ${BOOTSTRAP_LOCK} pnpm install`)
  })
})

describe('a faster dev start', () => {
  it('every dev step runs with Miniflare’s cf.json fetch off and a compile cache the backups carry', () => {
    const env = sessionProcessEnv(dev)
    expect(env.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false')
    expect(env.NODE_COMPILE_CACHE).toBe(NODE_COMPILE_CACHE_DIR)
    // Inside the workspace (a backup's `dir`), and not under one of the prebuild's excludes.
    expect(NODE_COMPILE_CACHE_DIR.startsWith(`${SESSION_WORKSPACE}/`)).toBe(true)
    const relative = NODE_COMPILE_CACHE_DIR.slice(SESSION_WORKSPACE.length + 1)
    for (const exclude of PREBUILD_EXCLUDES) expect(relative.startsWith(exclude)).toBe(false)
  })

  it('waits for the stack in ONE call per chunk — the API’s health, then Vite by TCP — and warms / after, unwaited', async () => {
    const fake = new FakeSandbox({ name: 's-ready' }).onProcess(/pnpm dev/, {
      lines: [],
      ports: [5173, 8787],
      hang: true,
    })
    await startDevServer(fake, dev)
    expect(fake.portWaits).toHaveLength(1)
    expect(fake.portWaits[0]).toMatchObject({
      port: 8787,
      opts: { path: '/api/health', followedBy: [{ port: 5173, tcp: true }], pidFile: DEV_PID_FILE },
    })
    expect(fake.processes.map(p => p.command)).toEqual([DEV_START_COMMAND, DEV_WARM_COMMAND])
    expect(fake.processes[0]?.opts?.env).toMatchObject({ CLOUDFLARE_CF_FETCH_ENABLED: 'false' })
    expect(DEV_WARM_COMMAND).toContain('http://127.0.0.1:5173/')

    // The warm-up failing to start changes nothing.
    const flaky = new FakeSandbox({ name: 's-warm' }).onProcess(/pnpm dev/, {
      lines: [],
      ports: [5173, 8787],
      hang: true,
    })
    const started = flaky.startProcess.bind(flaky)
    flaky.startProcess = async (command, opts) => {
      if (command === DEV_WARM_COMMAND) throw new Error('no curl')
      return started(command, opts)
    }
    await expect(startDevServer(flaky, dev)).resolves.toMatchObject({ processId: 'proc-1' })
  })

  it('no warm-up while the stack is not up', async () => {
    const fake = new FakeSandbox({ name: 's-api-down' }).onProcess(/pnpm dev/, {
      lines: [],
      ports: [5173],
      exitCode: 1,
    })
    await expect(startDevServer(fake, dev)).rejects.toBeInstanceOf(SessionBootstrapError)
    expect(fake.processes.map(p => p.command)).toEqual([DEV_START_COMMAND])
  })

  it('a warm resume’s probe is the same single wait', async () => {
    const fake = new FakeSandbox({ name: 's-probe' }).openPort(5173).openPort(8787)
    expect(await devServerAnswers(fake)).toBe(true)
    expect(fake.portWaits).toEqual([
      {
        port: DEV_READY_PROBE.port,
        opts: { path: '/api/health', followedBy: DEV_READY_PROBE.followedBy, timeoutMs: 3000 },
      },
    ])
    // Vite up, the API not: not answering.
    expect(await devServerAnswers(new FakeSandbox().openPort(5173))).toBe(false)
  })

  it('the pre-read is a background process that never throws, whatever the sandbox does', async () => {
    const fake = new FakeSandbox({ name: 's-preread' })
    await prereadHotFiles(fake)
    expect(fake.processes.map(p => p.command)).toEqual([PREREAD_COMMAND])
    expect(fake.execs).toEqual([])
    const broken = new FakeSandbox({ name: 's-preread-fail' }).failNext(
      'startProcess',
      new Error('the sandbox said no')
    )
    await expect(prereadHotFiles(broken)).resolves.toBeUndefined()
    for (const p of ['workerd', 'esbuild', 'wrangler-dist', 'miniflare', 'vite/dist']) {
      expect(DEV_HOT_PATHS.some(h => h.includes(p))).toBe(true)
    }
  })

  it('under a real shell the pre-read reads what is there, skips what is not, and exits 0', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'launch-preread-'))
    try {
      const vite = path.join(root, 'node_modules/.pnpm/vite@6.4.3_x/node_modules/vite/dist')
      mkdirSync(path.join(vite, 'node'), { recursive: true })
      writeFileSync(path.join(vite, 'node/index.js'), 'x'.repeat(1000))
      const command = PREREAD_COMMAND.split(SESSION_WORKSPACE).join(root)
      const res = spawnSync('bash', ['-c', command], { encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      expect(res.stdout).toBe('')
      // No workspace at all: still 0.
      const gone = PREREAD_COMMAND.split(SESSION_WORKSPACE).join(path.join(root, 'nope'))
      expect(spawnSync('bash', ['-c', gone]).status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a backup stops the dev server politely first: SIGTERM, a bounded wait, never a failure', async () => {
    expect(DEV_GRACEFUL_STOP_COMMAND).toContain(`cat ${DEV_PID_FILE}`)
    expect(DEV_GRACEFUL_STOP_COMMAND).toContain('kill -TERM "$pid"')
    expect(DEV_GRACEFUL_STOP_COMMAND).not.toContain('KILL "$pid"')
    expect(DEV_GRACEFUL_STOP_COMMAND).toContain('seq 1 50')
    const fake = new FakeSandbox({ name: 's-stop-dev' })
    await stopDevServerGracefully(fake)
    expect(fake.commands).toEqual([DEV_GRACEFUL_STOP_COMMAND])
    const broken = new FakeSandbox().failNext('exec', new Error('gone'))
    await expect(stopDevServerGracefully(broken)).resolves.toBeUndefined()
  })

  it('under a real shell the polite stop lets a SIGTERM handler finish, and is a no-op with nothing running', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'launch-devstop-'))
    try {
      const pidFile = path.join(root, 'dev.pid')
      const marker = path.join(root, 'flushed')
      const command = DEV_GRACEFUL_STOP_COMMAND.split(DEV_PID_FILE).join(pidFile)
      expect(spawnSync('bash', ['-c', command]).status).toBe(0)
      // A dev server that writes something on its way out (as node writes its compile cache).
      const server = path.join(root, 'server.cjs')
      writeFileSync(
        server,
        `const fs = require('node:fs')\nprocess.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(0) })\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`
      )
      const res = spawnSync('bash', [
        '-c',
        `'${process.execPath}' '${server}' & while [ ! -s '${pidFile}' ]; do sleep 0.05; done; ${command}`,
      ])
      expect(res.status).toBe(0)
      expect(readFileSync(marker, 'utf8')).toBe('yes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
