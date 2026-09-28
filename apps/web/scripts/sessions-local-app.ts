/**
 * `pnpm sessions:local-app` — register an app that LOCAL coding sessions can run on (Launch P3,
 * `docs/SESSIONS-LOCAL.md`): its repository goes into the local git server
 * (`scripts/sessions-local-git.mjs add`) and a matching `apps` row into this checkout's database,
 * so `POST /api/apps/:id/sessions` has something to clone. Node-only; the Worker never imports it.
 *
 *   pnpm sessions:local-app --slug demo --from /path/to/rocketflare --ref 0.15.0
 *     [--owner local] [--tenant <tenant slug>] [--git-root <dir>]
 *
 * - The repo is `<owner>/<slug>` (default owner `local`), with `main` at `--ref`.
 * - The app is `imported` and `live`, in `--tenant` (default: the single tenant, else `acme` —
 *   what `pnpm seed` creates), with a production environment and no Neon project: a local app's
 *   `dev` database is `launch_sessdev_<slug>` on `SESSION_LOCAL_DB_URL`, made by its first session.
 * - Re-running is safe: an existing repo is kept, and the row is updated in place.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'
import { appEnvironments, apps, tenants } from '../src/db/schema'

function flag(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  if (at >= 0 && process.argv[at + 1] && !process.argv[at + 1]?.startsWith('--')) {
    return process.argv[at + 1]
  }
  const inline = process.argv.find(a => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function fail(message: string): never {
  console.error(`sessions:local-app: ${message}`)
  process.exit(2)
}

async function main() {
  const slug = flag('slug') ?? fail('--slug is required')
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) fail(`--slug ${slug} is not an app slug`)
  const from = flag('from') ?? fail('--from <path|url> is required')
  const ref = flag('ref', 'HEAD') as string
  const owner = flag('owner', 'local') as string
  const gitRoot = path.resolve(
    flag('git-root') ??
      process.env.SESSIONS_LOCAL_GIT_ROOT ??
      path.join(os.homedir(), '.launch', 'sessions-git')
  )
  const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is not set (apps/web/.dev.vars)')

  // 1. The repository, in the local git server.
  const bare = path.join(gitRoot, owner, `${slug}.git`)
  if (existsSync(bare)) {
    console.log(`repo ${owner}/${slug} already in ${gitRoot} (kept)`)
  } else {
    const script = path.resolve(import.meta.dirname, '../../../scripts/sessions-local-git.mjs')
    const add = spawnSync(
      process.execPath,
      [script, 'add', `${owner}/${slug}`, '--from', from, '--ref', ref, '--root', gitRoot],
      { stdio: 'inherit' }
    )
    if (add.status !== 0) process.exit(add.status ?? 1)
  }

  // 2. The app row, in its tenant.
  const db = getScriptDatabase(url, process.env)
  const tenantSlug = flag('tenant')
  const all = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants)
  const tenant =
    (tenantSlug && all.find(t => t.slug === tenantSlug)) ||
    (all.length === 1 ? all[0] : all.find(t => t.slug === 'acme'))
  if (!tenant) fail(`no tenant ${tenantSlug ?? '(run pnpm seed, or pass --tenant)'}`)

  const values = {
    tenantId: tenant.id,
    slug,
    displayName: slug,
    source: 'imported' as const,
    templateVersion: ref,
    repoOwner: owner,
    repoName: slug,
    defaultBranch: 'main',
    status: 'live' as const,
  }
  const [existing] = await db
    .select({ id: apps.id, tenantId: apps.tenantId })
    .from(apps)
    .where(eq(apps.slug, slug))
  let appId: string
  if (existing) {
    if (existing.tenantId !== tenant.id) fail(`app ${slug} exists in another tenant`)
    await db
      .update(apps)
      .set({ ...values, sessionDb: null })
      .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, existing.id)))
    appId = existing.id
  } else {
    const [created] = await db.insert(apps).values(values).returning({ id: apps.id })
    if (!created) fail('the insert returned no row')
    appId = created.id
  }
  const [production] = await db
    .select({ id: appEnvironments.id })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenant.id),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'production')
      )
    )
  if (!production) {
    await db
      .insert(appEnvironments)
      .values({ tenantId: tenant.id, appId, name: 'production', workerName: slug })
  }
  console.log(`app ${slug} (${appId}) in tenant ${tenant.slug} → ${owner}/${slug}@main`)
  console.log(
    `start a session: POST /api/apps/${appId}/sessions, or pnpm sessions:smoke --app ${slug}`
  )
}

main()
  .then(() => closeAllDatabases())
  .catch(async err => {
    console.error(err)
    await closeAllDatabases()
    process.exit(1)
  })
