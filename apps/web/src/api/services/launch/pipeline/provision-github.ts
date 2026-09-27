/**
 * The GitHub half of creating (and archiving) an app (Launch P2, plan §3 2c steps 2, 3, 7, 9, 12):
 * installation tokens narrowed to what each step does, the repository itself, and the files the
 * pipeline reads and writes through the Git Data API — no clone anywhere.
 *
 * **Every token is narrowed.** Creating the repository needs `administration` on the organisation;
 * everything after it is scoped to THAT repository with only the permissions the step uses
 * (`contents`, `workflows`, `actions`, `environments`, `actions_variables`). A token is a secret:
 * callers hand it to `ctx.redact` and never record it.
 */

import {
  createOrgRepo,
  type GitHubPermissions,
  type GitHubRepo,
  getRepo,
  getRepoFile,
  installationToken,
  listInstallations,
} from '../github-app'
import type { PipelineVendors } from './context'
import { requireVendor } from './context'
import type { StepContext } from './operations'

type GitHubVendor = NonNullable<PipelineVendors['github']>

/** The installation on the configured org: the stored id, else looked up by the org's login. */
async function installationId(gh: GitHubVendor): Promise<string> {
  if (gh.installationId) return gh.installationId
  const found = (await listInstallations(gh.auth)).find(
    i => i.account?.login.toLowerCase() === gh.org.toLowerCase()
  )
  if (!found) throw new Error(`The GitHub App is not installed on ${gh.org}`)
  return String(found.id)
}

/** A token over the whole installation, narrowed to `permissions` (creating a repo needs this). */
export async function orgToken(
  vendors: PipelineVendors,
  permissions: GitHubPermissions,
  ctx?: Pick<StepContext, 'redact'>
): Promise<{ token: string; org: string }> {
  const gh = requireVendor(vendors, 'github')
  const { token } = await installationToken(gh.auth, await installationId(gh), { permissions })
  ctx?.redact(token)
  return { token, org: gh.org }
}

/** A token for ONE repository of the org, narrowed to `permissions`. */
export async function repoToken(
  vendors: PipelineVendors,
  repo: string,
  permissions: GitHubPermissions,
  ctx?: Pick<StepContext, 'redact'>
): Promise<{ token: string; owner: string }> {
  const gh = requireVendor(vendors, 'github')
  const { token } = await installationToken(gh.auth, await installationId(gh), {
    repositories: [repo],
    permissions,
  })
  ctx?.redact(token)
  return { token, owner: gh.org }
}

/**
 * The app's private repository `<org>/<slug>`, created with `auto_init` (so `main` exists to commit
 * onto) — or, on a retry, the one an earlier attempt recorded. A repository of that name that no
 * attempt recorded belongs to somebody else and is never adopted.
 */
export async function ensureRepo(
  vendors: PipelineVendors,
  ctx: StepContext,
  input: { name: string; description: string | null }
): Promise<GitHubRepo> {
  const { token, org } = await orgToken(
    vendors,
    { administration: 'write', contents: 'write', metadata: 'read' },
    ctx
  )
  const existing = await getRepo(token, org, input.name)
  if (existing) {
    if (ctx.prior.repoId && String(existing.id) === ctx.prior.repoId) return existing
    throw new Error(
      `A repository named ${org}/${input.name} already exists and Launch did not create it`
    )
  }
  const repo = await createOrgRepo(token, org, {
    name: input.name,
    description: input.description ?? undefined,
    private: true,
    autoInit: true,
  })
  await ctx.record({ repoId: String(repo.id), repo: repo.full_name })
  return repo
}

/** Several files of `ref` at once; a missing one is null. */
export async function readRepoFiles(
  token: string,
  owner: string,
  repo: string,
  paths: readonly string[],
  ref = 'main'
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    paths.map(async path => [path, await getRepoFile(token, owner, repo, path, ref)] as const)
  )
  return Object.fromEntries(entries)
}
