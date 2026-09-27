/**
 * Fixtures for the create-an-app pipeline suites (Launch P2, slice 2c):
 *
 * - `fakePorts()` — a stand-in for slice 2b's adapter and scaffold runner behind the
 *   `PipelinePorts` interface (`services/launch/pipeline/ports.ts`): the plan §1 naming table, a
 *   `writeConfig` that fills the kit placeholders and the §0.4 vars, a placeholder Worker built
 *   from the toml's DO / Workflow classes and `[[migrations]]`, and a runner that dispatches
 *   `launch-scaffold.yml` through the FakeCloud's GitHub.
 * - `fakeVendors(cloud)` — the resolved credentials, handed to the Workflow through `overrides`
 *   (the credential store is global and the setup suite owns it).
 * - `pushScaffold` / `finishDeploy` — what the scaffold job and the staging deploy leave behind,
 *   for the `onWait` hook: the rename's files committed to FakeGitHub and the ticket finished;
 *   an `active` staging ticket and a deployed version the fake host serves health from.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppLaunchParams,
  DEPLOY_FINISHED_EVENT,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { parse as parseToml } from 'smol-toml'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { dispatchWorkflow } from '@/api/services/launch/github-app'
import type { PipelineVendors } from '@/api/services/launch/pipeline/context'
import { createApp } from '@/api/services/launch/pipeline/create'
import type { AppResourceNames, PipelinePorts } from '@/api/services/launch/pipeline/ports'
import { AppLaunchWorkflow } from '@/api/workflows/app-launch'
import type { Database } from '@/db/client'
import { appEnvironments, deployTickets } from '@/db/schema'
import { createExecutionContext, createTestEnv, stubs } from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'
import { createTestTenantWithUser } from './auth'
import type { FakeCloud } from './fake-cloud'
import { uniqueSlug } from './launch-apps'

const FIXTURES = path.resolve(__dirname, '../fixtures/p2c')

/** The kit's two tomls as the rename leaves them for `slug`. */
export function scaffoldedTomls(slug: string): Record<AppEnvironmentName, string> {
  const read = (file: string) =>
    readFileSync(path.join(FIXTURES, file), 'utf8').replaceAll('__SLUG__', slug)
  return { production: read('wrangler.toml'), staging: read('wrangler.staging.toml') }
}

export const TOML_PATHS: Record<AppEnvironmentName, string> = {
  production: 'apps/web/wrangler.toml',
  staging: 'apps/web/wrangler.staging.toml',
}

function names(slug: string, env: AppEnvironmentName, domain: string): AppResourceNames {
  const sfx = env === 'staging' ? '-staging' : ''
  const host = `${slug}${sfx}.${domain}`
  return {
    workerName: `${slug}${sfx}`,
    kvTitle: `${slug}-rate-limit${sfx}`,
    queue: `${slug}-jobs${sfx}`,
    r2Bucket: `${slug}-files${sfx}`,
    workflow: `${slug}-agent-run${sfx}`,
    resendKeyName: `${slug}${sfx}`,
    host,
    url: `https://${host}`,
  }
}

function setVar(text: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`
  const re = new RegExp(`^${key}\\s*=.*$`, 'm')
  return re.test(text) ? text.replace(re, line) : text.replace(/^\[vars\]\s*$/m, `[vars]\n${line}`)
}

export interface FakePorts extends PipelinePorts {
  /** What the next `scaffoldRunner.poll` answers. */
  pollStatus: 'running' | 'succeeded' | 'failed'
  started: { owner: string; repo: string; ticketId: string }[]
}

export function fakePorts(): FakePorts {
  const ports: FakePorts = {
    pollStatus: 'running',
    started: [],
    names,
    writeConfig(text, _env, values) {
      let out = text.replace(
        /id = "<KV_RATE_LIMIT(?:_STAGING)?_ID>"/,
        `id = "${values.kvIds.RATE_LIMIT_KV}"`
      )
      out = out.replace(/^workers_dev = true$/m, 'workers_dev = false')
      out = setVar(out, 'APP_URL', values.appUrl)
      out = setVar(out, 'EMAIL_FROM', values.emailFrom)
      out = setVar(out, 'TENANCY_MODE', 'single')
      out = setVar(out, 'SIGNUP_MODE', 'open')
      out = setVar(out, 'OIDC_ISSUER', values.oidcIssuer)
      out = setVar(out, 'OIDC_CLIENT_ID', values.oidcClientId)
      out = setVar(out, 'AUTH_OIDC_ONLY', 'true')
      return out
    },
    placeholderScript(text, opts = {}) {
      const doc = parseToml(text) as Record<string, unknown>
      const classes = [
        ...(((doc.durable_objects as { bindings?: { class_name: string }[] })?.bindings ?? []).map(
          b => b.class_name
        ) ?? []),
        ...((doc.workflows as { class_name: string }[]) ?? []).map(w => w.class_name),
      ]
      const migrations = (doc.migrations as { tag: string; new_classes?: string[] }[]) ?? []
      const applied = opts.appliedTag ?? null
      const pending = applied
        ? migrations.slice(migrations.findIndex(m => m.tag === applied) + 1)
        : migrations
      const last = pending.at(-1)
      const module = [
        'export default { fetch() { return new Response("placeholder", { status: 503 }) } }',
        ...classes.map(c => `export class ${c} {}`),
      ].join('\n')
      return {
        metadata: {
          main_module: 'placeholder.mjs',
          compatibility_date: String(doc.compatibility_date),
          ...(last
            ? {
                migrations: {
                  ...(applied ? { old_tag: applied } : {}),
                  new_tag: last.tag,
                  steps: pending.map(m => ({ new_classes: m.new_classes ?? [] })),
                },
              }
            : {}),
        },
        modules: [{ name: 'placeholder.mjs', content: module }],
        migrationTag: last?.tag ?? applied,
      }
    },
    scaffoldFiles() {
      return [
        {
          path: '.github/workflows/launch-scaffold.yml',
          content: 'name: Launch scaffold\non: workflow_dispatch\n',
        },
        { path: '.launch/scaffold.mjs', content: '// the scaffold script\n' },
      ]
    },
    scaffoldRunner: {
      id: 'github-actions',
      async start(ctx) {
        ports.started.push({ owner: ctx.owner, repo: ctx.repo, ticketId: ctx.ticketId })
        await dispatchWorkflow(ctx.token, ctx.owner, ctx.repo, 'launch-scaffold.yml', {
          ref: 'main',
        })
        return { dispatched: 'launch-scaffold.yml' }
      },
      async poll() {
        return { status: ports.pollStatus, detail: 'the job exited 1' }
      },
    },
  }
  return ports
}

const { privateKey: GITHUB_APP_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

/** The four vendors, resolved, pointing at the FakeCloud's account, zone, org and domain. */
export function fakeVendors(cloud: FakeCloud, overrides: Partial<PipelineVendors> = {}) {
  const vendors: PipelineVendors = {
    settings: {
      appsDomain: cloud.opts.domain,
      notificationsDomain: `notifications.${cloud.opts.domain}`,
      templatePin: DEFAULT_TEMPLATE_PIN,
      appCreateRole: 'admin',
      githubOrg: cloud.opts.org,
    },
    cloudflare: {
      apiToken: 'cf-test-token-0123456789abcdef',
      accountId: cloud.opts.accountId,
      zoneId: cloud.opts.zoneId,
    },
    neon: { apiKey: 'neon-test-key-0123456789', orgId: 'org-test-1', regionId: 'aws-us-east-2' },
    resend: { apiKey: 're_test_0123456789', domainId: cloud.opts.resendDomainId },
    github: {
      auth: { appId: String(cloud.opts.appId), privateKey: GITHUB_APP_KEY },
      installationId: String(cloud.opts.installationId),
      org: cloud.opts.org,
    },
    ...overrides,
  }
  return vendors
}

/** What the scaffold job's push leaves: the renamed kit, its manifest, and no scaffold files. */
export function pushScaffold(
  cloud: FakeCloud,
  slug: string,
  opts: { kitVersion?: string; manifestSlug?: string } = {}
): string {
  const tomls = scaffoldedTomls(slug)
  return cloud.github.pushCommit(
    cloud.opts.org,
    slug,
    {
      '.rocketflare.json': JSON.stringify({
        kit: { name: 'rocketflare', version: opts.kitVersion ?? DEFAULT_TEMPLATE_PIN.tag },
        app: { slug: opts.manifestSlug ?? slug, display: slug, domain: cloud.opts.domain },
      }),
      [TOML_PATHS.production]: tomls.production,
      [TOML_PATHS.staging]: tomls.staging,
      '.github/workflows/deploy.yml': 'name: Deploy\non: workflow_dispatch\n',
      '.github/workflows/launch-scaffold.yml': null,
      '.launch/scaffold.mjs': null,
    },
    `Start from Rocketflare ${DEFAULT_TEMPLATE_PIN.tag}`
  )
}

/** `/ci/scaffold/done`'s effect on the ticket. */
export async function finishScaffoldTicket(
  db: Database,
  tenantId: string,
  ticketId: string,
  sha: string
): Promise<void> {
  await db
    .update(deployTickets)
    .set({ status: 'finished', sha, finishedAt: new Date() })
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, ticketId)))
}

/**
 * What a successful staging deploy leaves: an `active` ticket with a version, and the fake
 * script serving that version (so `/api/health` answers 200 with its `RELEASE_VERSION`).
 */
export async function finishDeploy(
  db: Database,
  cloud: FakeCloud,
  input: { tenantId: string; appId: string; slug: string; version?: string }
): Promise<string> {
  const [env] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, input.tenantId),
        eq(appEnvironments.appId, input.appId),
        eq(appEnvironments.name, 'staging')
      )
    )
  if (!env) throw new Error('no staging environment')
  const script = cloud.cloudflare.scripts.get(`${input.slug}-staging`)
  if (!script) throw new Error('no staging placeholder script')
  const version = input.version ?? '0.1.0'
  const versionId = crypto.randomUUID()
  script.versions.push({
    id: versionId,
    metadata: {},
    modules: {},
    bindings: [{ type: 'plain_text', name: 'RELEASE_VERSION', text: version }],
    createdAt: new Date(),
  })
  script.activeVersionId = versionId
  const [ticket] = await db
    .insert(deployTickets)
    .values({
      tenantId: input.tenantId,
      appId: input.appId,
      environmentId: env.id,
      purpose: 'deploy',
      status: 'active',
      runId: String(Date.now()),
      runAttempt: 1,
      version,
      cfVersionId: versionId,
      decisionSource: 'auto',
    })
    .returning({ id: deployTickets.id })
  if (!ticket) throw new Error('no ticket')
  return ticket.id
}

export interface Launch {
  params: AppLaunchParams
  slug: string
  tenantId: string
  userEmail: string
  ports: FakePorts
}

/**
 * Drives launches against one FakeCloud: `request()` is `POST /api/apps`'s service half (rows plus
 * the recorded instance), `run()` one instance of the Workflow (a retry is another `run()` with
 * the same params), and the default `onWait` plays the scaffold job and the staging deploy.
 */
export class LaunchHarness {
  constructor(
    private readonly db: Database,
    private readonly cloud: FakeCloud,
    /** Collects every tenant made, for `forgetApps` in `afterAll`. */
    private readonly tenantIds: string[]
  ) {}

  async request(opts: { deployStaging?: boolean; slug?: string } = {}): Promise<Launch> {
    const { user, tenant } = await createTestTenantWithUser(this.db, 'admin')
    this.tenantIds.push(tenant.id)
    const env = createTestEnv()
    const ports = fakePorts()
    const slug = opts.slug ?? uniqueSlug('shop')
    const { runId } = await createApp(
      this.db,
      stubs(env).launchWorkflow,
      ports,
      tenant.id,
      { slug, displayName: 'Shop', options: { deployStaging: opts.deployStaging ?? true } },
      { ...SYSTEM_ACTOR, actorType: 'user', actorUserId: user.id, actorEmail: user.email },
      { settings: fakeVendors(this.cloud).settings, missingSetup: async () => [] }
    )
    const created = stubs(env).launchWorkflow?.created.at(-1)
    if (!created || created.id !== runId) {
      throw new Error('createApp did not start the recorded instance')
    }
    return {
      params: created.params as AppLaunchParams,
      slug,
      tenantId: tenant.id,
      userEmail: user.email,
      ports,
    }
  }

  async run(launch: Launch, opts: { onWait?: (w: RecordedWait) => unknown } = {}) {
    const wf = new AppLaunchWorkflow(createExecutionContext(), createTestEnv())
    wf.overrides = {
      ports: launch.ports,
      vendors: fakeVendors(this.cloud),
      sleep: async () => {},
      health: { timeoutMs: 2000 },
    }
    const onWait =
      opts.onWait ??
      (async (wait: RecordedWait) => {
        if (wait.type === SCAFFOLD_FINISHED_EVENT) return this.scaffoldJob(launch)
        if (wait.type === DEPLOY_FINISHED_EVENT) return this.deployJob(launch)
        return undefined
      })
    const fake = createFakeWorkflowStep({ onWait })
    // Every value a step hands back, for the "no secret in a step result" check.
    const results: unknown[] = []
    const inner = fake.step.do.bind(fake.step) as (...args: unknown[]) => Promise<unknown>
    fake.step.do = (async (...args: unknown[]) => {
      const value = await inner(...args)
      results.push(value)
      return value
    }) as typeof fake.step.do
    const outcome = await wf.run(
      {
        payload: launch.params,
        timestamp: new Date(),
        instanceId: launch.params.runId,
        workflowName: 'launch-app-create',
      },
      fake.step as unknown as Parameters<AppLaunchWorkflow['run']>[1]
    )
    return { outcome, fake, results }
  }

  async scaffoldTicket(launch: Launch) {
    const [ticket] = await this.db
      .select()
      .from(deployTickets)
      .where(
        and(
          eq(deployTickets.tenantId, launch.tenantId),
          eq(deployTickets.appId, launch.params.appId),
          eq(deployTickets.purpose, 'scaffold')
        )
      )
    return ticket
  }

  /** The scaffold job: push the renamed kit, then `/ci/scaffold/done`. */
  async scaffoldJob(launch: Launch) {
    const ticket = await this.scaffoldTicket(launch)
    if (!ticket) throw new Error('no scaffold ticket')
    const sha = pushScaffold(this.cloud, launch.slug)
    await finishScaffoldTicket(this.db, launch.tenantId, ticket.id, sha)
    return { ticketId: ticket.id }
  }

  /** The staging deploy, through `finish`. */
  async deployJob(launch: Launch) {
    const ticketId = await finishDeploy(this.db, this.cloud, {
      tenantId: launch.tenantId,
      appId: launch.params.appId,
      slug: launch.slug,
    })
    return { ticketId }
  }
}
