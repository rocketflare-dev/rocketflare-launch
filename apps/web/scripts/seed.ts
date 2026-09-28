/**
 * Development seed (D9, D25) — idempotent, run as `pnpm seed` (loads .dev.vars). Multi-tenant:
 * tenant `Acme` (`acme`) with owner/admin/member `*@example.test` (verified), a pending invitation
 * for `invited@example.test`, one API key printed ONCE (only its hash is stored) and a global
 * admin `admin@clewro.com`. `TENANCY_MODE=single`: the single tenant is named after `APP_NAME`
 * with slug `default` instead, and the global admin is also its owner (single mode's owner/admin
 * is the platform admin — `owner@example.test` reaches Setup without the global flag). Node-only script; the Worker never imports it.
 *
 * `pnpm seed --demo` (or `SEED_DEMO=1`) additionally runs every installed plugin's `seedDemo` hook
 * (the analytics plugin seeds dashboards and rebuilds its fact table).
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { databaseUrlTarget } from '../../../scripts/lib/bootstrap-lib.mjs'
import { devPorts } from '../../../scripts/lib/dev-ports.mjs'
import { mintApiKey } from '../src/api/auth/api-keys'
import { hashToken } from '../src/api/utils/core/hash'
import { randomToken } from '../src/api/utils/core/ids'
import { createTenantForUser, getSingleTenant } from '../src/api/utils/db/tenant-helpers'
import { closeAllDatabases, type Database, getScriptDatabase } from '../src/db/client'
import { apiKeys, teamInvitations, tenants, tenantUsers, users } from '../src/db/schema'
import { serverPlugins } from '../src/plugins/server'

const DATABASE_URL = process.env.DATABASE_URL
const TENANCY_MODE = process.env.TENANCY_MODE === 'single' ? 'single' : 'multi'
const APP_NAME = process.env.APP_NAME || 'Launch'
const DEV_PORTS = devPorts()
const APP_URL = process.env.APP_URL || `http://localhost:${DEV_PORTS.ui}`
/** `wrangler dev`'s origin: APP_URL with the UI port swapped for the API's (a tunnel URL stays). */
function apiUrl(appUrl: string): string {
  const url = new URL(appUrl)
  if (url.port === String(DEV_PORTS.ui)) url.port = String(DEV_PORTS.api)
  return url.origin
}
const DEMO = process.argv.includes('--demo') || process.env.SEED_DEMO === '1'

const SEED_USERS = [
  { email: 'owner@example.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@example.test', name: 'Adam Admin', role: 'admin' },
  { email: 'member@example.test', name: 'Mia Member', role: 'member' },
] as const
const GLOBAL_ADMIN = { email: 'admin@clewro.com', name: 'Platform Admin' }
const INVITED_EMAIL = 'invited@example.test'
const SEED_KEY_NAME = 'Seed key'

async function upsertUser(
  db: Database,
  input: { email: string; name: string; isGlobalAdmin?: boolean }
) {
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
  })
  if (existing) {
    if (input.isGlobalAdmin && !existing.isGlobalAdmin) {
      await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, existing.id))
    }
    return existing
  }
  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      isGlobalAdmin: input.isGlobalAdmin ?? false,
      emailVerifiedAt: new Date(),
    })
    .returning()
  if (!created) throw new Error(`seed: could not create ${input.email}`)
  return created
}

async function ensureMembership(
  db: Database,
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member'
) {
  await db.insert(tenantUsers).values({ tenantId, userId, role }).onConflictDoNothing()
}

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required (pnpm seed loads .dev.vars)')
  // Always say where the rows are going — `pnpm bootstrap --db-url` points this at a remote
  // branch. Host and database only: the user and password never reach the terminal.
  console.log(`seeding ${databaseUrlTarget(DATABASE_URL)}`)
  if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error('Refusing to seed a non-local database (set SEED_ALLOW_REMOTE=1 to override)')
  }
  const db = getScriptDatabase(DATABASE_URL, process.env)
  const log = (s: string) => console.log(s)

  log(`Seeding (${TENANCY_MODE}-tenant mode)…`)
  const owner = await upsertUser(db, SEED_USERS[0])

  let tenant: typeof tenants.$inferSelect
  if (TENANCY_MODE === 'single') {
    const single = await getSingleTenant(db)
    tenant =
      single ??
      (await createTenantForUser(db, {
        name: APP_NAME,
        slug: 'default',
        userId: owner.id,
        role: 'owner',
      }))
  } else {
    const acme = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'acme') })
    tenant =
      acme ??
      (await createTenantForUser(db, {
        name: 'Acme',
        slug: 'acme',
        userId: owner.id,
        role: 'owner',
      }))
  }
  log(`  tenant  ${tenant.name} (${tenant.slug})`)

  for (const seedUser of SEED_USERS) {
    const user = await upsertUser(db, seedUser)
    await ensureMembership(db, tenant.id, user.id, seedUser.role)
    log(`  user    ${seedUser.email.padEnd(24)} ${seedUser.role}`)
  }

  const globalAdmin = await upsertUser(db, { ...GLOBAL_ADMIN, isGlobalAdmin: true })
  // Single mode: the organisation's owner/admin IS the platform admin (`canAdministerPlatform`), so
  // the platform admin is seeded as an OWNER — the same role `admitBootstrapAdmin` gives a
  // `BOOTSTRAP_ADMIN_EMAILS` address — and reaches Setup on the tenant role, not only the flag.
  // Upgraded on a re-seed (earlier seeds made it a member).
  if (TENANCY_MODE === 'single') {
    await db
      .insert(tenantUsers)
      .values({ tenantId: tenant.id, userId: globalAdmin.id, role: 'owner' })
      .onConflictDoUpdate({
        target: [tenantUsers.tenantId, tenantUsers.userId],
        set: { role: 'owner' },
      })
  }
  log(
    `  user    ${GLOBAL_ADMIN.email.padEnd(24)} global admin${TENANCY_MODE === 'single' ? ' + owner' : ''}`
  )

  const pendingInvite = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.tenantId, tenant.id),
      sql`lower(${teamInvitations.email}) = ${INVITED_EMAIL}`,
      isNull(teamInvitations.acceptedAt),
      isNull(teamInvitations.revokedAt)
    ),
  })
  if (!pendingInvite) {
    const token = randomToken(32)
    await db.insert(teamInvitations).values({
      tenantId: tenant.id,
      email: INVITED_EMAIL,
      role: 'member',
      tokenHash: await hashToken(token),
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending → ${APP_URL}/invite/${token}`)
  } else {
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending (existing)`)
  }

  const existingKey = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.tenantId, tenant.id),
      eq(apiKeys.name, SEED_KEY_NAME),
      isNull(apiKeys.revokedAt)
    ),
  })
  if (!existingKey) {
    const { plaintext } = await mintApiKey(db, {
      tenantId: tenant.id,
      createdByUserId: owner.id,
      name: SEED_KEY_NAME,
      scopes: ['read', 'write'],
    })
    log('')
    log('  API key (shown ONCE — only its hash is stored):')
    log(`    ${plaintext}`)
  } else {
    log(
      `  API key ${existingKey.keyPrefix}… already exists (revoke it and re-seed to mint a new one)`
    )
  }

  log('')
  log('Sign in locally (APP_ENV=development) without email:')
  log(`  curl -sS -X POST ${apiUrl(APP_URL)}/auth/dev-login \\`)
  log(
    `    -H 'Content-Type: application/json' -d '{"email":"${SEED_USERS[0].email}"}' -c cookies.txt`
  )
  log(
    `  or open ${APP_URL}/login and use the dev-login form with any *@example.test address above.`
  )
  log(`  Magic links are logged by wrangler dev when RESEND_API_KEY is unset.`)

  if (DEMO) await seedDemo(db, tenant, owner, log)
}

// =================================================================================================
// --demo: installed plugins add their demo rows (D31). The kit's own demo workspace was removed
// when Launch was seeded; each plugin's `hooks.seedDemo` still runs here.
// =================================================================================================

/**
 * A fixed UUID for a demo row: SHA-1 of a namespaced key, with the version nibble set to 5 and the
 * RFC 4122 variant bits set, so `z.string().uuid()` (which every API contract uses) accepts it.
 */
function demoId(key: string): string {
  const hex = createHash('sha1').update(`launch-demo:${key}`).digest('hex').slice(0, 32)
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function seedDemo(
  db: Database,
  tenant: typeof tenants.$inferSelect,
  owner: { id: string },
  log: (s: string) => void
) {
  log('')
  log('Demo data (--demo)…')
  // Fixed ids (`demoId` arrives already namespaced with the plugin's id) and
  // `onConflictDoNothing`, so re-running adds nothing. One plugin's failure is reported and the
  // rest still run.
  for (const plugin of serverPlugins) {
    if (!plugin.hooks?.seedDemo) continue
    try {
      await plugin.hooks.seedDemo(db, {
        tenantId: tenant.id,
        ownerId: owner.id,
        demoId: (key: string) => demoId(`${plugin.shared.id}:${key}`),
        log: line => log(`  ${plugin.shared.id.padEnd(7)} ${line}`),
      })
    } catch (error) {
      log(`  ${plugin.shared.id.padEnd(7)} FAILED: ${(error as Error).message}`)
    }
  }
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeAllDatabases())
