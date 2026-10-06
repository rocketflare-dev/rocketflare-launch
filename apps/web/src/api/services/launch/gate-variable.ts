/**
 * Issue #10: the `LAUNCH_GATE_APP_ID` repository Actions variable on an app's repo (CONCEPTS §18.13).
 *
 * The kit's `verified` CI job runs only when the variable is set, and then trusts only a
 * `launch/gate` check run (issue #9, `sessions/gate-attest.ts`) posted by the GitHub App whose
 * numeric id it holds — so the value is Launch's own App id (`github_app` credential, `appId`). A
 * kit without the job never reads it: setting it is harmless there.
 *
 * - {@link ensureGateVariable}: read, then write only when it differs (`unchanged` costs no write).
 *   Called by the `github_env` launch step (new apps), Apply on the branch-protection card
 *   (`POST /api/apps/:id/branch-protection`, existing and imported apps), the start of a kit
 *   upgrade ({@link ensureAppGateVariable}, best-effort — the upgrade that brings the job in), an
 *   import (best-effort, after its transaction) and the cron sweep ({@link sweepGateVariables},
 *   issue #21) for live apps Launch has not seen it on (`apps.gate_variable_set_at`).
 * - {@link diagnoseGateVariable}: `ok | missing | wrong | unknown`, reported beside the
 *   branch-protection diagnosis (`gateVariable`).
 *
 * Detaching an app is deleting the variable in the repo's settings: CI then runs the full gate on
 * every push, as it did before Launch. Launch has no detach flow that removes it.
 */
import { type AppGateVariable, LAUNCH_GATE_APP_ID_VARIABLE } from '@launch/shared/launch-apps'
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AppRow, apps } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import type { Logger } from '../../utils/core/logger'
import {
  GITHUB_TOKEN_PERMISSIONS,
  type GitHubOptions,
  getRepoVariable,
  upsertRepoVariable,
} from './github-app'
import { type ImportGitHub, loadImportGitHub } from './import'
import { type RepoGitHubOptions, withRepoToken } from './releases/github'

export { LAUNCH_GATE_APP_ID_VARIABLE }

export type GateVariableWrite = 'created' | 'updated' | 'unchanged'

/** The value Launch writes: its App id as GitHub shows it (a plain decimal integer). */
export function gateAppIdValue(appId: string | number): string {
  const value = String(appId).trim()
  if (!/^\d+$/.test(value)) throw new Error(`The GitHub App id is not numeric (${value})`)
  return value
}

/** Set the variable to Launch's App id unless it already holds it. Needs `actions_variables: write`. */
export async function ensureGateVariable(
  token: string,
  owner: string,
  repo: string,
  appId: string | number,
  opts: GitHubOptions = {}
): Promise<GateVariableWrite> {
  const expected = gateAppIdValue(appId)
  const current = await getRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, opts)
  if (current?.trim() === expected) return 'unchanged'
  await upsertRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, expected, opts)
  return current === null ? 'created' : 'updated'
}

/** What the repo holds against Launch's App id. Needs `actions_variables: read`; never throws. */
export async function diagnoseGateVariable(
  token: string,
  owner: string,
  repo: string,
  appId: string | number,
  opts: GitHubOptions = {}
): Promise<AppGateVariable> {
  let expected: string
  try {
    expected = gateAppIdValue(appId)
  } catch (err) {
    return { state: 'unknown', value: null, expected: null, detail: (err as Error).message }
  }
  let value: string | null
  try {
    value = await getRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, opts)
  } catch (err) {
    return {
      state: 'unknown',
      value: null,
      expected,
      detail: `GitHub could not read the ${LAUNCH_GATE_APP_ID_VARIABLE} variable: ${(err as Error).message}`,
    }
  }
  if (value === null) {
    return {
      state: 'missing',
      value: null,
      expected,
      detail: `${owner}/${repo} has no ${LAUNCH_GATE_APP_ID_VARIABLE} variable, so CI runs the full gate again on a change Launch already gated. Apply sets it.`,
    }
  }
  if (value.trim() !== expected) {
    return {
      state: 'wrong',
      value,
      expected,
      detail: `${owner}/${repo}'s ${LAUNCH_GATE_APP_ID_VARIABLE} is ${value}, not Launch's GitHub App (${expected}), so CI does not trust Launch's gate. Apply sets it.`,
    }
  }
  return { state: 'ok', value, expected, detail: null }
}

/** Issue #21: record that `app`'s repo holds the variable (`apps.gate_variable_set_at`). */
export async function markGateVariableSet(
  db: Database,
  app: Pick<AppRow, 'id' | 'tenantId'>,
  now = new Date()
): Promise<void> {
  await db
    .update(apps)
    .set({ gateVariableSetAt: now })
    .where(and(eq(apps.tenantId, app.tenantId), eq(apps.id, app.id)))
}

/**
 * Set the variable on `app`'s repo with a token narrowed to it — the start of a kit upgrade, an
 * import, the sweep — and record it (`markGateVariableSet`). Throws whatever GitHub or the token
 * mint refused (an installation without `actions_variables: write`); callers that must not fail
 * catch it.
 */
export async function ensureAppGateVariable(
  db: Database,
  cfg: AppConfig,
  app: Pick<AppRow, 'id' | 'tenantId' | 'repoOwner' | 'repoName' | 'defaultBranch'>,
  opts: RepoGitHubOptions = {}
): Promise<GateVariableWrite> {
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const write = await withRepoToken(
    db,
    cfg,
    app,
    GITHUB_TOKEN_PERMISSIONS.gateVariableWrite,
    (token, repo) => ensureGateVariable(token, repo.owner, repo.repo, github.auth.appId, opts),
    { ...opts, github }
  )
  await markGateVariableSet(db, app)
  return write
}

/** How many apps one sweep tick tries at most, and how long an app that failed waits to be retried. */
export const GATE_VARIABLE_SWEEP_BATCH = 20
export const GATE_VARIABLE_RETRY_MS = 60 * 60 * 1000

export interface GateVariableSweepReport {
  set: number
  failed: number
}

/**
 * Issue #21: `LAUNCH_GATE_APP_ID` on every live app's repo that Launch has not seen it on
 * (`gate_variable_set_at IS NULL`) — imported apps, and apps launched before issue #10 — so CI
 * trusts Launch's gate without anyone pressing Apply. ONE statement claims the batch
 * (`gate_variable_tried_at` stamped, so two ticks never try the same app, and an app GitHub refused
 * — an installation without `actions_variables: write` — waits {@link GATE_VARIABLE_RETRY_MS}),
 * then each is set best-effort. Cross-tenant like the other Launch crons; every write
 * tenant-first. No GitHub App connected → nothing is claimed.
 */
export async function sweepGateVariables(
  db: Database,
  cfg: AppConfig,
  opts: RepoGitHubOptions & {
    now?: Date
    logger?: Pick<Logger, 'warn'>
    /** Narrows the sweep to these organisations (tests). */
    tenantIds?: string[]
  } = {}
): Promise<GateVariableSweepReport> {
  const { now: at, logger, tenantIds, ...gh } = opts
  const now = at ?? new Date()
  const report: GateVariableSweepReport = { set: 0, failed: 0 }
  let github: ImportGitHub
  try {
    github = gh.github ?? (await loadImportGitHub(db, cfg))
  } catch {
    return report
  }
  const retryBefore = new Date(now.getTime() - GATE_VARIABLE_RETRY_MS)
  const due = db
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        tenantIds ? inArray(apps.tenantId, tenantIds) : undefined,
        eq(apps.status, 'live'),
        isNull(apps.archivedAt),
        isNull(apps.gateVariableSetAt),
        isNotNull(apps.repoOwner),
        isNotNull(apps.repoName),
        or(isNull(apps.gateVariableTriedAt), lt(apps.gateVariableTriedAt, retryBefore))
      )
    )
    .orderBy(asc(apps.createdAt))
    .limit(GATE_VARIABLE_SWEEP_BATCH)
  const claimed = await db
    .update(apps)
    .set({ gateVariableTriedAt: now })
    .where(
      and(
        inArray(apps.id, due),
        isNull(apps.gateVariableSetAt),
        or(isNull(apps.gateVariableTriedAt), lt(apps.gateVariableTriedAt, retryBefore))
      )
    )
    .returning()
  for (const app of claimed) {
    try {
      await ensureAppGateVariable(db, cfg, app, { ...gh, github })
      report.set++
    } catch (err) {
      report.failed++
      logger?.warn(
        { appId: app.id, err: err instanceof Error ? err.message : String(err) },
        'apps.gateVariable: could not set LAUNCH_GATE_APP_ID'
      )
    }
  }
  return report
}

/** The five-minute cron task (`scheduled.ts`): {@link sweepGateVariables}. */
export const gateVariableSweep: ScheduledTask = {
  name: 'apps.gateVariable',
  async run({ db, config, logger }) {
    const report = await sweepGateVariables(db, config, { logger })
    if (report.set > 0 || report.failed > 0) {
      logger.info(report, 'apps.gateVariable: swept apps missing LAUNCH_GATE_APP_ID')
    }
  },
}
