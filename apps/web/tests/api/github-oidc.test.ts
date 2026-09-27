/**
 * `/ci/*`'s two proofs (Launch P2). `verifyGitHubOidc`: only a token GitHub signed, for Launch's
 * audience and unexpired, gets through — a forged, wrong-audience, wrong-issuer or expired one is
 * one 401 (`github_oidc_invalid`). `resolveCaller`: a VALID token still has to be the registered
 * app's repository (by id AND name), a real environment, the named workflow file and the default
 * branch or a tag — anything else is a 403, and the tenant comes from the app row.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { resolveCaller } from '@/api/services/launch/ci/caller'
import { bearerToken, verifyGitHubOidc } from '@/api/services/launch/ci/github-oidc'
import { ApiError } from '@/api/utils/core/errors'
import { apps } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import {
  actionsClaims,
  actionsJwksFetch,
  DEFAULT_ACTIONS_AUDIENCE,
  mintActionsToken,
} from '../helpers/github-oidc'
import { seedApp } from '../helpers/launch-apps'

const db = setupTestDatabase()
const audience = DEFAULT_ACTIONS_AUDIENCE
const verify = (token: string, aud = audience) =>
  verifyGitHubOidc(token, { audience: aud, fetch: actionsJwksFetch() })

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  const err = await promise.then(
    () => null,
    e => e
  )
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${err}`)
  return { status: err.statusCode, code: err.code }
}

const claims = (over: Partial<Parameters<typeof actionsClaims>[0]> = {}) =>
  actionsClaims({ repository: 'acme/shop', repositoryId: '4242', environment: 'staging', ...over })

describe('verifyGitHubOidc', () => {
  it('accepts a token GitHub signed for this audience and returns its claims', async () => {
    const verified = await verify(await mintActionsToken(claims({ runId: '777' })))
    expect(verified).toMatchObject({
      iss: 'https://token.actions.githubusercontent.com',
      repository: 'acme/shop',
      repository_id: '4242',
      environment: 'staging',
      run_id: '777',
    })
  })

  it('verifies through a FakeCloud, which serves the JWKS at GitHub’s URL', async () => {
    const cloud = createFakeCloud()
    const token = await mintActionsToken(claims())
    await expect(verifyGitHubOidc(token, { audience, fetch: cloud.fetch })).resolves.toMatchObject({
      repository: 'acme/shop',
    })
    expect(cloud.callsTo('actions-oidc')).toHaveLength(1)
  })

  it.each([
    ['forged (signed with another key)', () => mintActionsToken(claims(), { forged: true })],
    ['for another audience', () => mintActionsToken(claims(), { audience: 'https://evil.test' })],
    ['from another issuer', () => mintActionsToken(claims(), { issuer: 'https://evil.test' })],
    ['expired', () => mintActionsToken(claims(), { expiresInSeconds: -60 })],
    [
      'missing a claim Launch needs',
      () => mintActionsToken({ ...claims(), job_workflow_ref: undefined }),
    ],
  ])('refuses a token %s with a 401', async (_label, mint) => {
    expect(await statusOf(verify(await mint()))).toEqual({
      status: 401,
      code: 'github_oidc_invalid',
    })
  })

  it('refuses garbage and a missing bearer with a 401', async () => {
    expect((await statusOf(verify('not-a-jwt'))).status).toBe(401)
    expect(() => bearerToken(null)).toThrow(ApiError)
    expect(() => bearerToken('Basic abc')).toThrow(ApiError)
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
  })
})

describe('resolveCaller', () => {
  async function registeredApp() {
    const tenant = await createTestTenant(db)
    const { app, environments } = await seedApp(db, tenant.id)
    const repositoryId = String(1_000_000 + Math.floor(Math.random() * 1_000_000))
    await db
      .update(apps)
      .set({ githubRepoId: repositoryId, defaultBranch: 'main' })
      .where(eq(apps.id, app.id))
    const repository = `${app.repoOwner}/${app.repoName}`
    return { tenant, app, environments, repository, repositoryId }
  }

  async function resolve(
    over: Partial<Parameters<typeof actionsClaims>[0]> & {
      repository: string
      repositoryId: string
    },
    opts: Parameters<typeof resolveCaller>[2] = { workflowFile: 'deploy.yml' }
  ) {
    const verified = await verify(
      await mintActionsToken(actionsClaims({ environment: 'staging', ...over }))
    )
    return resolveCaller(db, verified, opts)
  }

  it('maps the repository id and environment to the app, and takes the tenant from the row', async () => {
    const { tenant, app, environments, repository, repositoryId } = await registeredApp()
    const caller = await resolve({ repository, repositoryId })
    expect(caller.tenantId).toBe(tenant.id)
    expect(caller.app.id).toBe(app.id)
    expect(caller.environment.id).toBe(environments.find(e => e.name === 'staging')?.id)
    // A tag is allowed too (a release).
    await expect(
      resolve({ repository, repositoryId, ref: 'refs/tags/1.2.0' })
    ).resolves.toBeTruthy()
  })

  it('a job with no environment gets the default the caller names, or a 403', async () => {
    const { repository, repositoryId } = await registeredApp()
    const verified = await verify(
      await mintActionsToken(
        actionsClaims({ repository, repositoryId, workflowFile: 'launch-scaffold.yml' })
      )
    )
    expect(
      (await statusOf(resolveCaller(db, verified, { workflowFile: 'launch-scaffold.yml' }))).status
    ).toBe(403)
    const caller = await resolveCaller(db, verified, {
      workflowFile: 'launch-scaffold.yml',
      defaultEnvironment: 'staging',
    })
    expect(caller.environment.name).toBe('staging')
  })

  it.each([
    ['an unregistered repository id', { repositoryId: '1' }],
    ['a matching id under another repository name', { repository: 'acme/somebody-else' }],
    ['an environment the app does not have', { environment: 'qa' }],
    ['another workflow file', { workflowFile: 'ci.yml' }],
    ['a feature branch', { ref: 'refs/heads/feature/x' }],
    [
      'a workflow in ANOTHER repo',
      { extra: { job_workflow_ref: 'evil/repo/.github/workflows/deploy.yml@refs/heads/main' } },
    ],
  ])('refuses %s with a 403', async (_label, over) => {
    const { repository, repositoryId } = await registeredApp()
    expect(await statusOf(resolve({ repository, repositoryId, ...over }))).toEqual({
      status: 403,
      code: 'ci_caller_refused',
    })
  })

  it('refuses an archived app', async () => {
    const { app, repository, repositoryId } = await registeredApp()
    await db.update(apps).set({ status: 'archived' }).where(eq(apps.id, app.id))
    expect((await statusOf(resolve({ repository, repositoryId }))).status).toBe(403)
  })
})
