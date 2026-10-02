/**
 * A release as the wire carries it, with the stage it is stuck at (app page P2, plan decision 7):
 * `releaseFailedStage` (`@launch/shared/launch-releases`, pure) over the row and the app's two
 * environments — what each runs and whether its health check is up. Every route answering with a
 * release stamps it here, so the UI's Retry and the CLI read one derivation, never their own.
 */
import {
  type Release,
  type ReleaseFailedStage,
  type ReleaseStageEnvironment,
  releaseFailedStage,
  releaseSchema,
} from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppEnvironmentRow, type AppReleaseRow, appEnvironments } from '../../../../db/schema'

export interface StageEnvironments {
  staging: AppEnvironmentRow | null
  production: AppEnvironmentRow | null
}

/** The app's staging and production rows (either may be missing on an app still launching). */
export async function stageEnvironments(
  db: Database,
  tenantId: string,
  appId: string
): Promise<StageEnvironments> {
  const rows = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  return environmentsOf(rows)
}

/** Split already-loaded environment rows. Pure. */
export function environmentsOf(rows: readonly AppEnvironmentRow[]): StageEnvironments {
  return {
    staging: rows.find(r => r.name === 'staging') ?? null,
    production: rows.find(r => r.name === 'production') ?? null,
  }
}

function stageEnv(row: AppEnvironmentRow | null): ReleaseStageEnvironment | null {
  return row ? { lastDeployVersion: row.lastDeployVersion, healthStatus: row.healthStatus } : null
}

/** Where `row` is stuck, or null. Pure. */
export function failedStageOf(
  row: AppReleaseRow,
  envs: StageEnvironments,
  now: Date = new Date()
): ReleaseFailedStage | null {
  return releaseFailedStage(
    {
      status: row.status,
      version: row.version,
      error: row.error,
      productionTicketId: row.productionTicketId,
      updatedAt: row.updatedAt,
      tagRunSeen: row.tagRun !== null && row.tagRun !== undefined,
      staging: stageEnv(envs.staging),
      production: stageEnv(envs.production),
    },
    now
  )
}

/** `row` as `releaseSchema`, its `failedStage` stamped. */
export function toReleaseView(
  row: AppReleaseRow,
  envs: StageEnvironments,
  now: Date = new Date()
): Release {
  return releaseSchema.parse({ ...row, failedStage: failedStageOf(row, envs, now) })
}

/** Several rows of one app, the environments read once. */
export async function releaseViews(
  db: Database,
  tenantId: string,
  appId: string,
  rows: readonly AppReleaseRow[]
): Promise<Release[]> {
  if (rows.length === 0) return []
  const envs = await stageEnvironments(db, tenantId, appId)
  const now = new Date()
  return rows.map(row => toReleaseView(row, envs, now))
}
