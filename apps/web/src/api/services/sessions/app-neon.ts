/**
 * The Neon ids a `SessionAppRef` carries, from the app's environment rows: the project (production's
 * `neon.projectId` — staging is a branch of the SAME project, `environmentNeon`) and the staging
 * branch `dev` is cut from (`neon-session-db.ts`). Tenant-first, one query.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { appEnvironments } from '../../../db/schema'
import type { SessionAppRef } from './ports'

export async function loadAppNeon(
  db: Database,
  tenantId: string,
  appId: string
): Promise<Pick<SessionAppRef, 'neonProjectId' | 'neonStagingBranchId'>> {
  const rows = await db
    .select({ name: appEnvironments.name, neon: appEnvironments.neon })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        inArray(appEnvironments.name, ['production', 'staging'])
      )
    )
  const production = rows.find(r => r.name === 'production')?.neon
  const staging = rows.find(r => r.name === 'staging')?.neon
  const projectId = production?.projectId ?? null
  return {
    neonProjectId: projectId,
    // Only a staging branch of the production project: anything else is not this app's database.
    neonStagingBranchId:
      projectId && staging?.projectId === projectId ? (staging.branchId ?? null) : null,
  }
}
