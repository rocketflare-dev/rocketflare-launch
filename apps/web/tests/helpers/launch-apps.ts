/**
 * Registry fixtures for the `/api/apps` suites: an app row with its environments written
 * directly (import has its own suite), a unique valid slug, and the repo's OWN wrangler tomls and
 * `launch.plugins.json` as the Rocketflare files an import reads — real kit output, not a
 * hand-written approximation of it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { inArray } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { type AppEnvironmentRow, type AppRow, appEnvironments, apps } from '@/db/schema'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

/** A repo file's text, e.g. `apps/web/wrangler.toml`. */
export function repoFixture(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

/** A slug no other test uses, valid under spec/04's rules. */
export function uniqueSlug(prefix = 'app'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

export interface SeedAppInput {
  slug?: string
  displayName?: string
  status?: AppRow['status']
  ownerGroupId?: string | null
  /** Environment → URL (null = no URL). Defaults to both, on `https://<slug>[-staging].apps.test`. */
  environments?: Partial<Record<AppEnvironmentName, string | null>>
}

export async function seedApp(
  db: Database,
  tenantId: string,
  input: SeedAppInput = {}
): Promise<{ app: AppRow; environments: AppEnvironmentRow[] }> {
  const slug = input.slug ?? uniqueSlug()
  const [app] = await db
    .insert(apps)
    .values({
      tenantId,
      slug,
      displayName: input.displayName ?? `App ${slug}`,
      source: 'imported',
      templateVersion: '0.15.0',
      repoOwner: 'acme',
      repoName: slug,
      status: input.status ?? 'live',
      ownerGroupId: input.ownerGroupId ?? null,
    })
    .returning()
  if (!app) throw new Error('seedApp: insert returned no row')
  const urls = input.environments ?? {
    staging: `https://${slug}-staging.apps.test`,
    production: `https://${slug}.apps.test`,
  }
  const rows = Object.entries(urls) as Array<[AppEnvironmentName, string | null]>
  const environments =
    rows.length === 0
      ? []
      : await db
          .insert(appEnvironments)
          .values(
            rows.map(([name, url]) => ({
              tenantId,
              appId: app.id,
              name,
              url,
              workerName: name === 'staging' ? `${slug}-staging` : slug,
            }))
          )
          .returning()
  return { app, environments }
}

/**
 * Delete every app a suite registered. Tests normally leave their rows, but an environment with a
 * URL is POLLED by any later run of the `*\/5` task against the same database — and an import's
 * URLs come from real tomls, so they name real hosts. Call it from `afterAll`.
 */
export async function forgetApps(db: Database, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return
  await db.delete(apps).where(inArray(apps.tenantId, tenantIds))
}
