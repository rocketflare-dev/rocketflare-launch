/**
 * Workspace backups (Launch P3, fast resume): a destroyed container's `/workspace/app` —
 * checkout, `node_modules`, the app's `.dev.vars` — saved with the Sandbox SDK's `createBackup`
 * and put back with `restoreBackup`, so a COLD resume skips the clone and the install.
 *
 * - **When**: after the checkpoint of a suspend that destroys the container (a drain), and before
 *   `cool#N` destroys a kept one (`warm.ts`). Never on a rollout (the container is gone) or an end.
 * - **Restored only when it is still the truth**: the backup's `git rev-parse HEAD` equals the
 *   session's `head_sha` (the branch head the last checkpoint pushed) and it was taken on the same
 *   `SESSION_IMAGE_VERSION`; anything else — or a restore that fails — clones and installs as
 *   before. A backup never fails a suspend or a resume.
 * - **Where**: the `BACKUP_BUCKET` R2 binding (the SDK's fixed name; Launch points it at the
 *   `FILES` bucket), objects under `backups/<id>/` (`data.sqsh`, `meta.json` — the SDK's layout,
 *   {@link backupObjectKeys}). The SDK's `ttl` only makes a restore refuse an old backup: `cleanup`
 *   deletes a session's backup, a newer backup deletes the one it replaces, and an R2 lifecycle rule
 *   on `backups/` is the backstop (`docs/DEPLOY.md`).
 * - **The archive holds a credential**: the app's `.dev.vars` carries the session branch's URI and
 *   the app's own encryption key. It stays in Launch's own bucket, never in a response.
 *
 * Modes (`SESSION_WORKSPACE_BACKUP`, `config.ts`): `binding` moves the archive through the Durable
 * Object and the R2 binding (`localBucket: true` — the only mode `wrangler dev` supports; on the
 * SDK's default HTTP transport a restore holds the whole archive in the Durable Object's memory,
 * base64, so it suits a laptop, not a 128 MB isolate); `presigned` is the SDK's deployed path (the
 * container uploads and downloads over presigned R2 URLs and a restore mounts the archive with
 * FUSE) and needs R2 S3 credentials plus the R2 endpoint on the allow-list ({@link backupEgressHosts}).
 */
import type { AppConfig } from '../../../config'

export type WorkspaceBackupMode = 'off' | 'binding' | 'presigned'

/** `SESSION_WORKSPACE_BACKUP`, or its default: `binding` in development, else `off`. */
export function workspaceBackupMode(
  cfg: Pick<AppConfig, 'SESSION_WORKSPACE_BACKUP' | 'APP_ENV'>
): WorkspaceBackupMode {
  return cfg.SESSION_WORKSPACE_BACKUP ?? (cfg.APP_ENV === 'development' ? 'binding' : 'off')
}

/**
 * The hosts the container must reach to move an archive itself (`presigned`): the R2 S3 endpoint
 * the SDK signs URLs for — `BACKUP_BUCKET_ENDPOINT`'s host, else `<account>.r2.cloudflarestorage.com`.
 * Empty in every other mode, and when no endpoint can be derived (the SDK then refuses the backup).
 */
export function backupEgressHosts(
  cfg: Pick<
    AppConfig,
    | 'SESSION_WORKSPACE_BACKUP'
    | 'APP_ENV'
    | 'BACKUP_BUCKET_ENDPOINT'
    | 'CLOUDFLARE_R2_ACCOUNT_ID'
    | 'CLOUDFLARE_ACCOUNT_ID'
  >
): string[] {
  if (workspaceBackupMode(cfg) !== 'presigned') return []
  if (cfg.BACKUP_BUCKET_ENDPOINT) return [new URL(cfg.BACKUP_BUCKET_ENDPOINT).hostname]
  const account = cfg.CLOUDFLARE_R2_ACCOUNT_ID ?? cfg.CLOUDFLARE_ACCOUNT_ID
  return account ? [`${account}.r2.cloudflarestorage.com`] : []
}

/** The SDK's R2 objects for one backup (`backups/<id>/data.sqsh` and `meta.json`). */
export function backupObjectKeys(id: string): string[] {
  return [`backups/${id}/data.sqsh`, `backups/${id}/meta.json`]
}

/** How long past the session's suspended expiry a backup stays restorable. */
export const BACKUP_TTL_MARGIN_SECONDS = 3600
