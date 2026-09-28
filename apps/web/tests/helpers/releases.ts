/**
 * Fixtures for the P4 release suites (slice 4d): a deployable app (`deploy-gateway.ts`) whose repo
 * also carries a root `package.json` at a version, a Launch session that shipped a PR into it, the
 * app's staging and production hosts answering health from whatever version is live in the
 * FakeCloud, and a `deploy.yml` job calling `/ci/deploy` on a given ref.
 */
import { recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import type { Database } from '@/db/client'
import type { SessionRow } from '@/db/schema'
import type { TestEnv } from '../mocks/bindings'
import { type DeployableApp, deployClaims, seedDeployableApp } from './deploy-gateway'
import type { FakeCloud } from './fake-cloud'
import { mintActionsToken } from './github-oidc'
import { request } from './request'
import { insertSession } from './sessions'

export interface ReleasableApp extends DeployableApp {
  owner: string
  repo: string
}

/** A deployable app whose `main` carries `package.json` at `version`. */
export async function seedReleasableApp(
  db: Database,
  cloud: FakeCloud,
  tenantId: string,
  version = '0.1.0'
): Promise<ReleasableApp> {
  const seeded = await seedDeployableApp(db, cloud, tenantId)
  const owner = seeded.app.repoOwner as string
  const repo = seeded.app.repoName as string
  cloud.github.pushCommit(owner, repo, {
    'package.json': `{\n  "name": "${repo}",\n  "private": true,\n  "version": "${version}"\n}\n`,
  })
  return { ...seeded, owner, repo }
}

/** Both hosts answer `/api/health` with the RELEASE_VERSION of their Worker's live version. */
export function serveAppHosts(cloud: FakeCloud, seeded: DeployableApp): void {
  for (const env of [seeded.staging, seeded.production]) {
    const host = new URL(env.url as string).host
    cloud.onHost(host, req => {
      const live = cloud.cloudflare.activeVersion(env.workerName as string)
      const version = live?.bindings.find(b => b.name === 'RELEASE_VERSION')?.text
      if (!live) return new Response('no version', { status: 503 })
      if (req.url.pathname === '/api/health') {
        return Response.json({ status: 'ok', version: version ?? null })
      }
      return Response.json({ ok: true })
    })
  }
}

/** A branch off `main` with one commit and a PR from it, opened by `author`. */
export function openPullOnBranch(
  cloud: FakeCloud,
  app: ReleasableApp,
  input: { branch: string; title: string; author?: string; file?: string }
) {
  const repo = cloud.github.repo(app.owner, app.repo)
  const main = repo?.refs.get('heads/main')
  if (!repo || !main) throw new Error('openPullOnBranch: no repo or main')
  repo.refs.set(`heads/${input.branch}`, main)
  cloud.github.pushCommit(
    app.owner,
    app.repo,
    { [input.file ?? `src/${input.branch.replace(/\W/g, '-')}.ts`]: `// ${input.title}\n` },
    input.title,
    input.branch
  )
  return cloud.github.openPull(app.owner, app.repo, {
    head: input.branch,
    title: input.title,
    author: input.author ?? 'octocat',
  })
}

/**
 * A Launch session by `user` that shipped a PR (as `ship.ts` leaves it: `shipped`, `pr_number`,
 * audited `session.shipped`). The PR is opened in the FakeCloud by the App's bot.
 */
export async function shipSessionPr(
  db: Database,
  cloud: FakeCloud,
  app: ReleasableApp,
  input: { tenantId: string; userId: string; title: string }
): Promise<{ session: SessionRow; number: number }> {
  const branch = `session/${Math.random().toString(36).slice(2, 10)}`
  const pull = openPullOnBranch(cloud, app, {
    branch,
    title: input.title,
    author: 'launch-app[bot]',
  })
  const session = await insertSession(
    db,
    {
      tenant: { id: input.tenantId } as never,
      user: { id: input.userId } as never,
      app: app.app,
    },
    {
      status: 'shipped',
      branch,
      title: input.title,
      prNumber: pull.number,
      prUrl: `https://github.com/${app.owner}/${app.repo}/pull/${pull.number}`,
      endedAt: new Date(),
    }
  )
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: input.tenantId,
    action: 'session.shipped',
    targetType: 'session',
    targetId: session.id,
    appId: app.app.id,
    summary: { after: { prNumber: pull.number, branch, title: input.title } },
  })
  return { session, number: pull.number }
}

/** A `deploy.yml` job of `seeded`'s repo calling `/ci/deploy…` as one run, on `ref`. */
export function deployJob(
  env: TestEnv,
  seeded: DeployableApp,
  environment: 'staging' | 'production',
  opts: { ref?: string; runId?: string; actor?: string } = {}
) {
  const runId = opts.runId ?? String(5_000_000 + Math.floor(Math.random() * 1_000_000))
  const claims = {
    ...deployClaims(seeded, environment, { runId, ref: opts.ref }),
    ...(opts.actor ? { actor: opts.actor } : {}),
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const token = await mintActionsToken(claims)
    return request(
      `/ci/deploy${path}`,
      { method, headers: { Authorization: `Bearer ${token}` } },
      { env, ...(body === undefined ? {} : { json: body }) }
    )
  }
  return { runId, claims, call }
}
