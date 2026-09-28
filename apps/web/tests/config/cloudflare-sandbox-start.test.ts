/**
 * `CloudflareSandbox.start` (Launch P3, fast resume): the container boots BEFORE the runtime
 * allow-list is applied, each attempt is bounded, and an attempt that never answers (seen under
 * `wrangler dev` on a start seconds after a destroy) is followed by a reset and one more attempt.
 * Plus the one ordering the warm suspend depends on: the SDK's own idle sleep outlasts the warm
 * window.
 */
import { describe, expect, it } from 'vitest'
import { SandboxBackupUnavailableError } from '@/api/services/sessions/ports'
import {
  CloudflareSandbox,
  SESSION_SANDBOX_SLEEP_AFTER,
  START_ATTEMPTS,
} from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import { SESSION_WARM_KEEP_MINUTES, warmMinutesLeft } from '@/api/services/sessions/warm'
import { backupEgressHosts, workspaceBackupMode } from '@/api/services/sessions/workspace-backup'
import type { AppConfig } from '@/config'
import { FakeSandboxNamespace } from '../mocks/bindings'

function sandboxOver(ns: FakeSandboxNamespace, startAttemptMs = 50): CloudflareSandbox {
  return new CloudflareSandbox(
    ns as unknown as ConstructorParameters<typeof CloudflareSandbox>[0],
    's-start',
    { cfg: {} as AppConfig, startAttemptMs }
  )
}

const methods = (ns: FakeSandboxNamespace) => ns.calls.map(c => c.method)

describe('CloudflareSandbox.start', () => {
  it('boots the container first, then applies the allow-list with the extra hosts', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => ({ exitCode: 0, stdout: '', stderr: '' })
    await sandboxOver(ns).start({ extraAllowedHosts: ['ep-x.us-east-2.aws.neon.tech'] })
    expect(methods(ns)).toEqual(['exec', 'setAllowedHosts'])
    expect(ns.calls[1]?.args[0]).toContain('ep-x.us-east-2.aws.neon.tech')
    expect(ns.calls[1]?.args[0]).toContain('registry.npmjs.org')
  })

  it('resets and tries once more when an attempt never answers', async () => {
    const ns = new FakeSandboxNamespace()
    let execs = 0
    ns.handlers.exec = () => {
      execs++
      // The first boot hangs (a stale Durable Object after a destroy); the second answers.
      return execs === 1 ? new Promise(() => {}) : { exitCode: 0, stdout: '', stderr: '' }
    }
    await sandboxOver(ns).start()
    expect(methods(ns)).toEqual(['exec', 'destroy', 'exec', 'setAllowedHosts'])
  })

  it(`gives up after ${START_ATTEMPTS} attempts with a readable error`, async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => new Promise(() => {})
    await expect(sandboxOver(ns).start()).rejects.toThrow(
      /The session container did not start within/
    )
    expect(methods(ns).filter(m => m === 'exec')).toHaveLength(START_ATTEMPTS)
  })

  it('does not retry a start that failed for another reason', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => ({ exitCode: 1, stdout: '', stderr: '' })
    await expect(sandboxOver(ns).start()).rejects.toThrow('The session container did not start')
    expect(methods(ns)).toEqual(['exec'])
  })
})

describe('CloudflareSandbox workspace backups', () => {
  const bucket = () => {
    const deleted: string[][] = []
    return { deleted, r2: { delete: async (keys: string[]) => void deleted.push(keys) } }
  }
  const over = (
    ns: FakeSandboxNamespace,
    cfg: Partial<AppConfig>,
    r2?: { delete: (keys: string[]) => Promise<void> }
  ) =>
    new CloudflareSandbox(
      ns as unknown as ConstructorParameters<typeof CloudflareSandbox>[0],
      's-backup',
      { cfg: cfg as AppConfig, ...(r2 ? { backupBucket: r2 as unknown as R2Bucket } : {}) }
    )

  it('binding mode: createBackup through the binding, git-ignored files included', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.createBackup = (_name, opts) => ({
      id: 'b-1',
      dir: (opts as { dir: string }).dir,
      localBucket: true,
    })
    const { r2 } = bucket()
    const sandbox = over(ns, { APP_ENV: 'development' }, r2)
    expect(sandbox.backupHosts).toEqual([])
    const handle = await sandbox.backup({ dir: '/workspace/app', ttlSeconds: 90_000, name: 'x' })
    expect(handle).toEqual({ id: 'b-1', dir: '/workspace/app', localBucket: true })
    expect(ns.calls[0]?.args[0]).toEqual({
      dir: '/workspace/app',
      ttl: 90_000,
      name: 'x',
      gitignore: false,
      localBucket: true,
    })
  })

  it('presigned mode: no localBucket, and the R2 endpoint is a backup host', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.createBackup = () => ({ id: 'b-2', dir: '/workspace/app' })
    const { r2 } = bucket()
    const sandbox = over(
      ns,
      {
        APP_ENV: 'production',
        SESSION_WORKSPACE_BACKUP: 'presigned',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
      },
      r2
    )
    expect(sandbox.backupHosts).toEqual(['acct.r2.cloudflarestorage.com'])
    await sandbox.backup({ dir: '/workspace/app', ttlSeconds: 60 })
    expect(ns.calls[0]?.args[0]).not.toHaveProperty('localBucket')
  })

  it('off (the deployed default), or no BACKUP_BUCKET: the backup is refused by name', async () => {
    const ns = new FakeSandboxNamespace()
    const { r2 } = bucket()
    await expect(
      over(ns, { APP_ENV: 'production' }, r2).backup({ dir: '/workspace/app', ttlSeconds: 60 })
    ).rejects.toBeInstanceOf(SandboxBackupUnavailableError)
    await expect(
      over(ns, { APP_ENV: 'development' }).backup({ dir: '/workspace/app', ttlSeconds: 60 })
    ).rejects.toBeInstanceOf(SandboxBackupUnavailableError)
    expect(ns.calls).toEqual([])
  })

  it('restores through restoreBackup and deletes the SDK’s two objects', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.restoreBackup = () => ({ success: true, dir: '/workspace/app', id: 'b-3' })
    const { r2, deleted } = bucket()
    const sandbox = over(ns, { APP_ENV: 'development' }, r2)
    await sandbox.restore({ id: 'b-3', dir: '/workspace/app', localBucket: true })
    expect(ns.calls[0]).toMatchObject({
      method: 'restoreBackup',
      args: [{ id: 'b-3', dir: '/workspace/app', localBucket: true }],
    })
    await sandbox.deleteBackup({ id: 'b-3', dir: '/workspace/app' })
    expect(deleted).toEqual([['backups/b-3/data.sqsh', 'backups/b-3/meta.json']])
  })

  it('the mode defaults to binding in development and off elsewhere', () => {
    expect(workspaceBackupMode({ APP_ENV: 'development' } as AppConfig)).toBe('binding')
    expect(workspaceBackupMode({ APP_ENV: 'staging' } as AppConfig)).toBe('off')
    expect(
      workspaceBackupMode({
        APP_ENV: 'production',
        SESSION_WORKSPACE_BACKUP: 'presigned',
      } as AppConfig)
    ).toBe('presigned')
    expect(
      backupEgressHosts({
        APP_ENV: 'production',
        SESSION_WORKSPACE_BACKUP: 'presigned',
        BACKUP_BUCKET_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com',
      } as AppConfig)
    ).toEqual(['acct.eu.r2.cloudflarestorage.com'])
  })
})

describe('the warm window', () => {
  it("is shorter than the SDK's own idle sleep, so the Workflow cools a kept container first", () => {
    const sleepMinutes = Number(/^(\d+)m$/.exec(SESSION_SANDBOX_SLEEP_AFTER)?.[1])
    expect(sleepMinutes).toBeGreaterThan(SESSION_WARM_KEEP_MINUTES + 15)
  })

  it('counts down from when the container was kept', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    expect(warmMinutesLeft(null, now)).toBeNull()
    expect(warmMinutesLeft(now, now)).toBe(SESSION_WARM_KEEP_MINUTES)
    expect(warmMinutesLeft(new Date(now.getTime() - 10 * 60_000), now)).toBe(
      SESSION_WARM_KEEP_MINUTES - 10
    )
    expect(warmMinutesLeft(new Date(now.getTime() - 90 * 60_000), now)).toBe(0)
  })
})
