/**
 * Issue #16: the `SessionWorkflow` steps around the app's prebuild (`prebuild.ts`) — the ones a
 * coding session's first boot runs, and the ones a `prebuild` run is made of.
 *
 * A first boot (only while prebuilds are on, `prebuildsEnabled`):
 *
 *   prebuild.check  (no checklist line) is there a prebuild this session can restore? — a
 *                   `workspace.prebuild` `skipped` row says why not
 *   restore[.rN]    instead of `repo`: put the prebuild back, check the session's commit out over
 *                   it in place, and compare the lockfiles — `install: false` tells `bootstrap` to
 *                   leave the install out. A failed restore says why (`failed`) and the boot clones
 *   prebuild.request after `dev`, when the boot found none to use or its lockfile had moved on:
 *                   ask for a new one (never fails the boot)
 *
 * A merge Launch made: `prebuild.refresh#N` (the same request — the default branch moved).
 *
 * A `prebuild` run: `sandbox.start → prebuild.build → prebuild.save → cleanup`.
 *
 * Every step body here keeps `steps.ts`'s rules: it re-reads the row, its results are ids, shas
 * and flags, and it is safe to retry (the build's checkout and install re-run on the same
 * container; a save retried after its archive landed orphans that archive, which the bucket's
 * lifecycle rule deletes).
 */
import {
  CODING_SESSION_KINDS,
  type SessionWorkspacePrebuildData,
} from '@launch/shared/launch-sessions'
import type { AppPrebuildBackup, SessionRow } from '../../../db/schema'
import { safeErrorMessage } from './events'
import { SandboxRestartedError, sandboxHostOf, sessionAllowedHosts } from './ports'
import {
  followUpPrebuild,
  loadPrebuild,
  PREBUILD_EXCLUDES,
  PREBUILD_TTL_SECONDS,
  prebuildModeFor,
  recordPrebuild,
  releasePrebuildClaim,
  requestPrebuild,
  unusablePrebuild,
} from './prebuild'
import {
  installDependencies,
  prereadHotFiles,
  SESSION_IMAGE_VERSION,
  SESSION_WORKSPACE,
  workspaceFacts,
} from './rocketflare-dev'
import {
  backupFailureReason,
  bootstrapPolling,
  checkOut,
  clearRestoredWorkspace,
  dbEgressHostsOf,
  devEnvFor,
  emitterFor,
  inOurContainer,
  loadAppRef,
  loadSession,
  type StepScope,
  sandboxFor,
} from './steps'

/** One `workspace.prebuild` row on the running session's log; a failure to write it is logged. */
async function recordPrebuildEvent(
  scope: StepScope,
  turn: number,
  data: SessionWorkspacePrebuildData
): Promise<void> {
  await emitterFor(scope)({ type: 'workspace.prebuild', turn, data }).catch(err =>
    scope.logger.warn({ err }, 'session: could not record the prebuild event')
  )
}

// ---- a coding session's first boot -------------------------------------------------------------

export interface PrebuildCheckResult {
  /** A prebuild this session can restore instead of cloning and installing. */
  usable: boolean
  /** None this session could use: ask for one once the boot is done (`prebuild.request`). */
  refresh: boolean
  reason?: string
}

/**
 * Step `prebuild.check` (no checklist line): whether the app's prebuild can be restored into this
 * session's container — the same image, backup mode and sandbox host, not too old
 * (`unusablePrebuild`). Not a coding session, or prebuilds or backups off: nothing to do at all.
 */
export async function prebuildCheckStep(scope: StepScope): Promise<PrebuildCheckResult> {
  const session = await loadSession(scope)
  const host = sandboxHostOf(session)
  const coding = (CODING_SESSION_KINDS as readonly string[]).includes(session.kind)
  const mode = prebuildModeFor(scope.cfg, host)
  if (!coding || !mode) return { usable: false, refresh: false }
  const row = await loadPrebuild(scope.db, session.tenantId, session.appId)
  const why = unusablePrebuild(row, scope.cfg, host, scope.now())
  if (!why) return { usable: true, refresh: false }
  await recordPrebuildEvent(scope, 0, { status: 'skipped', mode, reason: why.reason })
  // Built for the other host or mode: not rebuilt for this one (no local/remote ping-pong).
  return { usable: false, refresh: why.rebuild, reason: why.reason }
}

export interface PrebuildRestoreResult {
  /** The workspace is the prebuild, checked out at the session's commit: `repo` is skipped. */
  restored: boolean
  /** The lockfile differs from the prebuild's (or is unknown): `bootstrap` installs. */
  install: boolean
  /** Ask for a new prebuild once the boot is done: the restore failed, or the lockfile moved on. */
  refresh: boolean
  reason?: string
  stepDetail?: string
}

/**
 * Step `restore[.rN]` of a first boot: the app's prebuild into the fresh container, its HEAD
 * checked against the prebuild's commit, then the session's own commit checked out over it IN
 * PLACE (`checkoutScript`'s `restored`) — `node_modules` stays. Never throws for the restore or the
 * checkout over it: whatever goes wrong is cleared away, recorded (`workspace.prebuild` `failed`)
 * and answered `{ restored: false }`, and the boot clones as before (the checklist line says so).
 * A container replaced under it is a `SandboxRestartedError`, as in every boot step.
 */
export async function prebuildRestoreStep(
  scope: StepScope,
  bootId?: string
): Promise<PrebuildRestoreResult> {
  const session = await loadSession(scope)
  const host = sandboxHostOf(session)
  const row = await loadPrebuild(scope.db, session.tenantId, session.appId)
  const why = unusablePrebuild(row, scope.cfg, host, scope.now())
  if (why || !row?.backup) {
    const reason = why?.reason ?? 'no prebuild yet'
    return {
      restored: false,
      install: true,
      refresh: why?.rebuild ?? true,
      reason,
      stepDetail: `Cloning instead: ${reason}`,
    }
  }
  const backup = row.backup
  const app = await loadAppRef(scope, session.appId)
  const sandbox = sandboxFor(scope, session)
  const started = Date.now()
  return inOurContainer(scope, sandbox, bootId, async () => {
    try {
      const dbHosts = await dbEgressHostsOf(scope, session)
      const extra = sandbox.backupHosts
      try {
        if (extra.length) {
          await sandbox.setAllowedHosts(sessionAllowedHosts([...dbHosts, ...extra]))
        }
        await sandbox.restore(backup)
      } finally {
        if (extra.length) {
          await sandbox.setAllowedHosts(sessionAllowedHosts(dbHosts)).catch(() => {})
        }
      }
      const restoredAt = await workspaceFacts(sandbox)
      if (restoredAt.headSha !== row.baseSha) {
        throw new Error('the restored workspace is not at the prebuild’s commit')
      }
      // A presigned restore mounts the archive lazily from R2: page the dev server's biggest files in
      // while the checkout and the bootstrap run (in the background, never waited on).
      await prereadHotFiles(sandbox)
      await checkOut(scope, await loadSession(scope), app, sandbox, { restored: true })
      const facts = await workspaceFacts(sandbox)
      // No lockfile to compare: install (cheap over a restored tree), but a new prebuild would
      // have none either — only a lockfile that MOVED asks for one.
      const changed = facts.lockfileHash !== row.lockfileHash
      // An archive that came back without `node_modules` (one saved before PREBUILD_EXCLUDES were
      // bare names had none) installs too, and asks for a prebuild that has them.
      const missing = !facts.installed
      const install = changed || missing || facts.lockfileHash === null
      await recordPrebuildEvent(scope, 0, {
        status: 'restored',
        ...(row.mode ? { mode: row.mode } : {}),
        ...(row.baseSha ? { baseSha: row.baseSha } : {}),
        lockfile: install ? 'changed' : 'same',
        durationMs: Math.max(0, Date.now() - started),
      })
      return {
        restored: true,
        install,
        refresh: changed || missing,
        ...(changed
          ? { reason: 'the lockfile changed' }
          : missing
            ? { reason: 'the prebuild has no node_modules' }
            : {}),
        ...(install
          ? {
              stepDetail: missing
                ? 'The prebuild has no node_modules: installing'
                : 'The lockfile differs from the prebuild’s: installing',
            }
          : {}),
      }
    } catch (err) {
      if (err instanceof SandboxRestartedError) throw err
      const reason = backupFailureReason(err)
      scope.logger.warn({ err }, 'session: prebuild restore failed; cloning instead')
      await clearRestoredWorkspace(sandbox)
      await recordPrebuildEvent(scope, 0, {
        status: 'failed',
        ...(row.mode ? { mode: row.mode } : {}),
        reason,
      })
      return {
        restored: false,
        install: true,
        refresh: true,
        reason,
        stepDetail: `Cloning instead: ${safeErrorMessage(err, 'the restore failed')}`,
      }
    }
  })
}

/**
 * Step `prebuild.request` (after a first boot) and `prebuild.refresh#N` (after a merge Launch
 * made): ask for a new prebuild of the session's app on its sandbox host (`requestPrebuild`).
 * `notBuiltSince`: the session's start for a boot — a prebuild saved since is already newer than
 * the one it found — or now for a merge. Never throws: a prebuild never fails a session.
 */
export async function prebuildRequestStep(
  scope: StepScope,
  input: { reason: string; after: 'boot' | 'merge' }
): Promise<{ requested: boolean; reason: string }> {
  try {
    const session = await loadSession(scope)
    const now = scope.now()
    const result = await requestPrebuild(scope.db, scope.env, scope.cfg, {
      tenantId: session.tenantId,
      appId: session.appId,
      host: sandboxHostOf(session),
      now,
      notBuiltSince: input.after === 'boot' ? session.createdAt : now,
    })
    if (!result.requested) {
      // Why nothing was asked for (a build in flight, the container cap, a recent failure…).
      await recordPrebuildEvent(scope, session.turnCount, {
        status: 'deferred',
        reason: result.reason,
      })
      return { requested: false, reason: result.reason }
    }
    await recordPrebuildEvent(scope, session.turnCount, {
      status: 'requested',
      reason: input.reason,
      prebuildSessionId: result.sessionId,
    })
    return { requested: true, reason: input.reason }
  } catch (err) {
    scope.logger.warn({ err }, 'session: could not ask for a prebuild')
    return { requested: false, reason: safeErrorMessage(err, 'the request failed', 400) }
  }
}

// ---- a `prebuild` run ----------------------------------------------------------------------------

/** What `prebuild.build` checked out and installed — ids and hashes only. */
export interface PrebuildBuildResult {
  baseSha: string
  treeSha: string
  lockfileHash: string | null
  buildMs: number
  /** The session image this run's container booted (`sessions.image_version`, set at its claim). */
  imageVersion: string
}

/**
 * Step `prebuild.build`: clone the app's default branch (detached, no runtime files) and
 * `pnpm install` it — the same command a session's bootstrap runs, so the archive's
 * `node_modules` is what a session would have made. No database, no kit bootstrap.
 */
export async function prebuildBuildStep(
  scope: StepScope,
  bootId?: string
): Promise<PrebuildBuildResult> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const sandbox = sandboxFor(scope, session)
  return inOurContainer(scope, sandbox, bootId, async () => {
    const started = Date.now()
    await checkOut(scope, session, app, sandbox)
    await scope.progress?.('pnpm install')
    await installDependencies({
      sandbox,
      dev: devEnvFor(scope.cfg, session),
      ...bootstrapPolling(scope, sandbox, bootId),
    })
    const facts = await workspaceFacts(sandbox)
    return {
      baseSha: facts.headSha,
      treeSha: facts.treeSha,
      lockfileHash: facts.lockfileHash,
      buildMs: Math.max(0, Date.now() - started),
      imageVersion: session.imageVersion ?? SESSION_IMAGE_VERSION,
    }
  })
}

/**
 * Step `prebuild.save`: the workspace archived ({@link PREBUILD_EXCLUDES} left out) and made the
 * app's prebuild — only while this run still holds the claim; then the archive it replaced is
 * deleted (one per app). An archive no row took (the claim was taken over) is deleted at once.
 * Throws when the archive cannot be made: the run fails, and `fail` gives the claim back with the
 * reason (`releasePrebuildClaim`), which holds off the next request for a while.
 */
export async function prebuildSaveStep(
  scope: StepScope,
  bootId: string | undefined,
  built: PrebuildBuildResult
): Promise<{ saved: boolean }> {
  const session = await loadSession(scope)
  const host = sandboxHostOf(session)
  const mode = prebuildModeFor(scope.cfg, host)
  const ref = { tenantId: session.tenantId, appId: session.appId, sessionId: session.id }
  if (!mode) {
    await releasePrebuildClaim(scope.db, {
      ...ref,
      error: 'backups or prebuilds were turned off',
      now: scope.now(),
    })
    return { saved: false }
  }
  const app = await loadAppRef(scope, session.appId)
  const sandbox = sandboxFor(scope, session)
  const started = Date.now()
  const backup: AppPrebuildBackup = await inOurContainer(scope, sandbox, bootId, async () => {
    const extra = sandbox.backupHosts
    try {
      if (extra.length) await sandbox.setAllowedHosts(sessionAllowedHosts(extra))
      return await sandbox.backup({
        dir: SESSION_WORKSPACE,
        ttlSeconds: PREBUILD_TTL_SECONDS,
        name: `prebuild-${app.slug}`,
        excludes: PREBUILD_EXCLUDES,
      })
    } finally {
      if (extra.length) await sandbox.setAllowedHosts(sessionAllowedHosts()).catch(() => {})
    }
  })
  const { recorded, replaced } = await recordPrebuild(scope.db, ref, {
    backup,
    mode,
    sandboxHost: host,
    baseSha: built.baseSha,
    treeSha: built.treeSha,
    lockfileHash: built.lockfileHash,
    buildMs: built.buildMs,
    builtAt: scope.now(),
    imageVersion: built.imageVersion,
  })
  const evict = recorded ? replaced : backup
  if (evict) {
    // Best effort: the bucket's lifecycle rule on `backups/` is the backstop.
    await sandbox.deleteBackup(evict).catch(err => {
      scope.logger.warn({ err }, 'session: could not delete a replaced prebuild')
    })
  }
  if (recorded) {
    await recordPrebuildEvent(scope, 0, {
      status: 'saved',
      mode,
      baseSha: built.baseSha,
      durationMs: Math.max(0, Date.now() - started),
    })
  }
  // A request that came while this run was building: build again from the newer default branch.
  if (recorded) await followUpStep(scope, session)
  return { saved: recorded }
}

/**
 * The follow-up of a `prebuild` run that gave its claim back (`prebuild.save`, and `cleanup` for
 * one that failed or was abandoned): `followUpPrebuild`, its request recorded on the run's log.
 * Never throws.
 */
export async function followUpStep(scope: StepScope, run: SessionRow): Promise<void> {
  try {
    const result = await followUpPrebuild(scope.db, scope.env, scope.cfg, run, scope.now())
    if (!result) return
    await recordPrebuildEvent(
      scope,
      0,
      result.requested
        ? {
            status: 'requested',
            reason: 'asked for while this one was building',
            prebuildSessionId: result.sessionId,
          }
        : { status: 'deferred', reason: result.reason }
    )
  } catch (err) {
    scope.logger.warn({ err }, 'session: could not follow a prebuild up')
  }
}
