/**
 * The checkpoint's scan (`checkpointScanScript` + `CHECKPOINT_ADD_COMMAND`, `services/sessions/
 * checkpoint.ts`) run for real, with bash and git, in a scratch repository: core dumps are
 * excluded by name, a directory called `core` and a `core.ts` are not, and a file over the size
 * limit is listed and left unstaged — never deleted. The container is Linux; this runs wherever the
 * gate runs, so the script's `stat` falls back to BSD's. Also the turn's kill script
 * (`turnKillScript`, `turn.ts`) against real processes.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ADD_COMMAND,
  CORE_DUMP_EXCLUDES,
  checkpointScanScript,
  parseLargeFiles,
  skippedFilesMessage,
} from '@/api/services/sessions/checkpoint'
import { checkoutScript } from '@/api/services/sessions/steps'
import { turnKillScript } from '@/api/services/sessions/turn'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-scan-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(path.join(dir, 'tracked.txt'), 'a\n')
  git('add', '-A')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}

const bash = (cwd: string, script: string) =>
  execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' })
const staged = (cwd: string) =>
  execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort()

describe('the checkpoint scan', () => {
  it('excludes core dumps by name, but not a core/ directory or core.ts', () => {
    const dir = repo()
    const put = (rel: string, text = 'x\n') => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), text)
    }
    put('core')
    put('apps/web/core')
    put('core.1234')
    put('qemu_claude_20260928-101500_77.core')
    put('src/core/index.ts')
    put('src/core.ts')
    const out = bash(dir, checkpointScanScript())
    expect(parseLargeFiles(out)).toEqual([])
    bash(dir, CHECKPOINT_ADD_COMMAND)
    expect(staged(dir)).toEqual(['src/core.ts', 'src/core/index.ts'])

    // Idempotent: the patterns are there once each, in order, however often it runs.
    bash(dir, checkpointScanScript())
    const exclude = readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').split('\n')
    expect(exclude.filter(l => (CORE_DUMP_EXCLUDES as readonly string[]).includes(l))).toEqual([
      ...CORE_DUMP_EXCLUDES,
    ])
  })

  it('leaves a file over the limit unstaged (untracked or modified), lists it, and keeps it', () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'big file.bin'), 'y'.repeat(2048))
    writeFileSync(path.join(dir, '-dash.bin'), 'y'.repeat(2048))
    writeFileSync(path.join(dir, 'tracked.txt'), 'z'.repeat(4096))
    writeFileSync(path.join(dir, 'small.txt'), 'ok\n')
    const out = bash(dir, checkpointScanScript(1024))
    const large = parseLargeFiles(out).sort((a, b) => a.path.localeCompare(b.path))
    expect(large).toEqual([
      { path: '-dash.bin', bytes: 2048 },
      { path: 'big file.bin', bytes: 2048 },
      { path: 'tracked.txt', bytes: 4096 },
    ])
    bash(dir, CHECKPOINT_ADD_COMMAND)
    expect(staged(dir)).toEqual(['small.txt'])
    expect(readFileSync(path.join(dir, 'big file.bin'), 'utf8')).toHaveLength(2048)
    expect(skippedFilesMessage(large, 1024)).toContain('big file.bin (2.0 KB)')
  })

  it('removes a stale index.lock that a timed-out git left behind', () => {
    const dir = repo()
    const lock = path.join(dir, '.git/index.lock')
    writeFileSync(lock, '')
    // Older than any checkpoint command may run, so it is stale even while some other git runs
    // on this machine (the test must not depend on what else the host is doing).
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo)
    writeFileSync(path.join(dir, 'new.txt'), 'n\n')
    bash(dir, checkpointScanScript())
    bash(dir, CHECKPOINT_ADD_COMMAND)
    expect(staged(dir)).toEqual(['new.txt'])
  })

  it('the turn kill script: SIGTERM first, SIGKILL for a process that ignores it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'launch-kill-'))
    dirs.push(dir)
    const pidFile = path.join(dir, 'turn.pid')
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const startTurn = (body: string) => {
      const child = spawn('bash', ['-c', `echo $$ > ${pidFile}; exec bash -c '${body}'`], {
        stdio: 'ignore',
      })
      return new Promise<number>(resolve => {
        const poll = () => {
          const pid = Number(readFileSync(pidFile, { encoding: 'utf8', flag: 'a+' }).trim())
          if (pid) resolve(pid)
          else setTimeout(poll, 20)
        }
        poll()
      }).then(pid => ({ pid, exited: new Promise(r => child.on('exit', r)) }))
    }

    // Asynchronously, so Node can reap the child: a zombie still answers `kill -0`.
    const kill = (file: string) =>
      new Promise<string>((resolve, reject) =>
        execFile('bash', ['-c', turnKillScript(1, file)], { cwd: dir }, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        )
      )
    const polite = await startTurn('sleep 30')
    expect(await kill(pidFile)).not.toContain('killed')
    await polite.exited
    expect(alive(polite.pid)).toBe(false)

    rmSync(pidFile)
    const stubborn = await startTurn('trap "" TERM; while :; do sleep 0.1; done')
    expect(await kill(pidFile)).toContain('killed')
    await stubborn.exited
    expect(alive(stubborn.pid)).toBe(false)

    // Nothing recorded, or already gone: nothing to do.
    expect(await kill(path.join(dir, 'none.pid'))).toBe('')
  })

  it('the repo step writes the same patterns into the exclude file', () => {
    const script = checkoutScript({ url: 'u', baseRef: 'main', branch: null })
    for (const pattern of CORE_DUMP_EXCLUDES) expect(script).toContain(`'${pattern}'`)
  })
})
