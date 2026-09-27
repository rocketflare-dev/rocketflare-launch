/**
 * The deploy job's short-lived migration credential (Launch P2, spec/03 "Database", DEPLOYER.md
 * `migratorUrl`). The environment's `migrator` role owns database `app`, so it can run the kit's
 * `pnpm db:migrate:ci`; it has **no stored credential**. Launch resets its password when a build
 * has passed the binding check, hands the URI to that one run, and resets it again at `activate`
 * or `finish` — so the password the job saw is dead the moment the deploy ends.
 *
 * - **The right branch.** Each `app_environments.neon` records its own `branchId`: staging's is
 *   the `staging` branch, production's is `main`. A branch inherits its parent's passwords, so a
 *   reset on one never touches the other.
 * - **The direct host** (`pooled=false`): migrations need a session, and DEPLOYER.md prefers it.
 * - **Never logged, never stored, never in an error.** The URI is returned to the caller and
 *   nowhere else; a Neon failure surfaces as Neon's own message, which carries no password.
 */
import type { AppEnvironmentNeon } from '@launch/shared/launch-apps'
import { ConflictError } from '../../../utils/core/errors'
import type { NeonClient } from '../neon'

/** The roles and database the pipeline creates (plan §1 "Neon"). */
export const MIGRATOR_ROLE = 'migrator'
export const APP_DATABASE = 'app'

interface MigratorTarget {
  projectId: string
  branchId: string
  role: string
  database: string
}

/** Where this environment's migrator lives, or a 409 when the pipeline never recorded it. */
export function migratorTarget(neon: AppEnvironmentNeon | null | undefined): MigratorTarget {
  if (!neon?.projectId || !neon.branchId) {
    throw new ConflictError(
      'This environment has no Neon branch recorded, so Launch cannot issue migration credentials',
      'deploy_neon_missing'
    )
  }
  return {
    projectId: neon.projectId,
    branchId: neon.branchId,
    role: neon.migratorRole ?? MIGRATOR_ROLE,
    database: neon.databaseName ?? APP_DATABASE,
  }
}

/**
 * Reset `migrator`'s password on the environment's branch and return its fresh DIRECT URI to
 * database `app`. The reset's operations are awaited, so the password works when the job uses it.
 */
export async function issueMigratorUrl(
  neon: NeonClient,
  env: AppEnvironmentNeon | null | undefined
): Promise<string> {
  const target = migratorTarget(env)
  const reset = await neon.resetRolePassword(target.projectId, target.branchId, target.role)
  await neon.waitForOperations(target.projectId, reset.operations ?? [])
  return neon.connectionUri(target.projectId, {
    branchId: target.branchId,
    databaseName: target.database,
    roleName: target.role,
    pooled: false,
  })
}

/** Reset `migrator`'s password again and discard it: whatever the job was given stops working. */
export async function revokeMigrator(
  neon: NeonClient,
  env: AppEnvironmentNeon | null | undefined
): Promise<void> {
  const target = migratorTarget(env)
  await neon.resetRolePassword(target.projectId, target.branchId, target.role)
}
