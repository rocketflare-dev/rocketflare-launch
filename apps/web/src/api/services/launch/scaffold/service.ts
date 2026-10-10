/**
 * What `/ci/scaffold/*` does once the caller is proven (`routes/ci-scaffold.ts` verifies the OIDC
 * token and resolves the caller first):
 *
 * - `issueScaffoldToken` — the plan (the app's names, the apps domain and the APP'S kit at the pin
 *   its launch run planned — D36 K3), then the ticket CLAIM (compare-and-set: a second call is a
 *   409), then a one-hour installation token narrowed to the ONE repo and `contents` + `workflows`
 *   write, and — when the GitHub App is installed on the kit repo's owner (a private kit) — a
 *   second token narrowed to the KIT repo and `contents: read` ({@link mintKitReadToken}). The
 *   names are checked before the claim so a missing setting does not burn the ticket; a failed
 *   mint after the claim marks the ticket `failed`, and the launch run's retry opens a new one.
 *   The tokens are returned once and never stored or audited.
 * - `completeScaffold` — the ticket `finished` with the pushed commit, then `SCAFFOLD_FINISHED_EVENT`
 *   to the launch run's Workflow instance. The row is the truth: an event that cannot be delivered
 *   is logged, not failed, and the run's wait falls back to reading the ticket.
 *
 * **Which pin.** The `scaffold.start` step records the pin it planned on its row
 * ({@link scaffoldPinIds}); the token route hands the job THAT pin, read through the ticket's
 * launch run, so a kit re-pinned between the dispatch and the job's call cannot change what the
 * job builds (and `scaffold.verify` checks against the same record). A ticket with no recorded
 * pin (a run from before K3) gets the app's kit's current pin (`appScaffoldPin`).
 */
import type { AppOperationExternalIds } from '@launch/shared/launch-apps'
import {
  SCAFFOLD_FINISHED_EVENT,
  type ScaffoldPlan,
  type ScaffoldTokenResponse,
} from '@launch/shared/launch-pipeline'
import { type TemplatePin, templatePinSchema } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AppRow, appOperations, type DeployTicketRow } from '../../../../db/schema'
import { ApiError, ConflictError } from '../../../utils/core/errors'
import type { ResolvedCaller } from '../ci/caller'
import { getSetting } from '../credentials'
import {
  type GitHubAppAuth,
  type GitHubOptions,
  installationToken,
  listInstallations,
} from '../github-app'
import { loadImportGitHub } from '../import'
import { appScaffoldPin, defaultKitPin } from '../kit-pin'
import { adapterFor } from '../kits/adapter'
import { launchInstanceOf } from '../pipeline/instance'
import { claimScaffoldTicket, failScaffoldTicket, finishScaffoldTicket } from './tickets'

/** The permissions the scaffold job's token carries — and nothing else. */
export const SCAFFOLD_TOKEN_PERMISSIONS = { contents: 'write', workflows: 'write' } as const

/** The permissions the kit read token carries: the kit repo's contents, read-only. */
export const KIT_TOKEN_PERMISSIONS = { contents: 'read' } as const

/** The DEFAULT kit's pin (D36 K1, `kit-pin.ts`) — what an app with no kit is cut from. */
export async function resolveTemplatePin(db: Database): Promise<TemplatePin> {
  return (await defaultKitPin(db)).pin
}

/** The ids `scaffold.start` records for the pin it planned (string values: `app_operations`). */
export function scaffoldPinIds(pin: TemplatePin): Record<string, string> {
  return {
    kitRepo: pin.repo,
    kitCommit: pin.commit,
    ...(pin.tag ? { kitTag: pin.tag } : {}),
  }
}

/** The pin a `scaffold.start` row recorded, or null (a row from before D36 K3). */
export function scaffoldPinOf(ids: AppOperationExternalIds): TemplatePin | null {
  if (!ids.kitRepo || !ids.kitCommit) return null
  const parsed = templatePinSchema.safeParse({
    repo: ids.kitRepo,
    commit: ids.kitCommit,
    ...(ids.kitTag ? { tag: ids.kitTag } : {}),
  })
  return parsed.success ? parsed.data : null
}

/** The pin the ticket's launch run planned (its `scaffold.start` row), else the app's kit's. */
async function ticketPin(
  db: Database,
  app: AppRow,
  ticket: Pick<DeployTicketRow, 'tenantId' | 'launchRunId'>
): Promise<TemplatePin> {
  if (ticket.launchRunId) {
    const [row] = await db
      .select({ externalIds: appOperations.externalIds })
      .from(appOperations)
      .where(
        and(
          eq(appOperations.tenantId, ticket.tenantId),
          eq(appOperations.runId, ticket.launchRunId),
          eq(appOperations.step, 'scaffold.start')
        )
      )
      .limit(1)
    const recorded = row ? scaffoldPinOf(row.externalIds) : null
    if (recorded) return recorded
  }
  return appScaffoldPin(db, app)
}

/** The apps domain, or 409 — every name in the plan is built from it. */
async function appsDomain(db: Database): Promise<string> {
  const domain = await getSetting<string>(db, 'apps_domain')
  if (typeof domain !== 'string' || domain.trim() === '') {
    throw new ConflictError('Set the apps domain in Setup first', 'apps_domain_not_configured')
  }
  return domain.trim().toLowerCase()
}

/**
 * The scaffold plan for the caller's app at `pin` (the app's kit's when omitted). No secret.
 * `kitId` is the app's kit as its adapter knows it — the kit the job's script was generated for.
 */
export async function scaffoldPlanFor(
  db: Database,
  caller: ResolvedCaller,
  pin?: TemplatePin
): Promise<ScaffoldPlan> {
  const domain = await appsDomain(db)
  const { app } = caller
  const kitPin = pin ?? (await appScaffoldPin(db, app))
  const adapter = await adapterFor(db, app)
  return {
    slug: app.slug,
    displayName: app.displayName,
    domain,
    repo: `${app.repoOwner}/${app.repoName}`,
    kitRepo: kitPin.repo,
    tag: kitPin.tag ?? null,
    commit: kitPin.commit,
    kitId: adapter.id,
  }
}

export interface ScaffoldGitHub {
  auth: GitHubAppAuth
  installationId: number | string | null
  org: string | null
}

export interface IssueScaffoldTokenOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  /** Skip the credential store (tests). */
  github?: ScaffoldGitHub
  now?: Date
}

/**
 * A read-only token for the KIT repo alone (`contents: read`, narrowed to that one repository),
 * when the GitHub App is installed on the kit's owner — a private kit lives there. Null when it is
 * not: the kit is then expected to be public and the job clones it anonymously (a token over an
 * unrelated installation would not be narrowed to the kit, so none is minted). Never logged.
 */
export async function mintKitReadToken(
  github: Pick<ScaffoldGitHub, 'auth'>,
  kitRepo: string,
  opts: GitHubOptions
): Promise<{ token: string; expires_at: string } | null> {
  const [owner = '', name = ''] = kitRepo.split('/')
  const installations = await listInstallations(github.auth, opts)
  const own = installations.find(i => i.account?.login.toLowerCase() === owner.toLowerCase())
  if (!own) return null
  return installationToken(
    github.auth,
    own.id,
    { repositories: [name], permissions: { ...KIT_TOKEN_PERMISSIONS } },
    opts
  )
}

/** The installation that can write to `owner`'s repos. */
async function installationFor(
  github: ScaffoldGitHub,
  owner: string,
  opts: GitHubOptions
): Promise<number | string> {
  const sameOrg = !github.org || github.org.toLowerCase() === owner.toLowerCase()
  if (github.installationId !== null && sameOrg) return github.installationId
  const installations = await listInstallations(github.auth, opts)
  const match = installations.find(i => i.account?.login.toLowerCase() === owner.toLowerCase())
  if (!match) throw new Error(`The GitHub App is not installed on ${owner}`)
  return match.id
}

export interface IssuedScaffoldToken {
  response: ScaffoldTokenResponse
  ticket: DeployTicketRow
}

export async function issueScaffoldToken(
  db: Database,
  cfg: AppConfig,
  caller: ResolvedCaller,
  opts: IssueScaffoldTokenOptions = {}
): Promise<IssuedScaffoldToken> {
  // The names first: a missing apps domain must not burn the ticket.
  await appsDomain(db)
  const github = opts.github ?? (await loadImportGitHub(db, cfg))

  const ticket = await claimScaffoldTicket(db, caller, opts.now)
  if (!ticket) {
    throw new ConflictError(
      'No scaffold is waiting for this repository, or its token was already issued',
      'scaffold_token_unavailable'
    )
  }
  const plan = await scaffoldPlanFor(db, caller, await ticketPin(db, caller.app, ticket))

  const ghOpts: GitHubOptions = { fetch: opts.fetch, apiBase: opts.apiBase }
  let token: { token: string; expires_at: string }
  let kitToken: { token: string } | null
  try {
    const installationId = await installationFor(github, caller.app.repoOwner ?? '', ghOpts)
    token = await installationToken(
      github.auth,
      installationId,
      { repositories: [caller.app.repoName ?? ''], permissions: { ...SCAFFOLD_TOKEN_PERMISSIONS } },
      ghOpts
    )
    kitToken = await mintKitReadToken(github, plan.kitRepo, ghOpts)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'GitHub refused the installation token'
    await failScaffoldTicket(db, ticket, `Could not mint the scaffold token: ${reason}`)
    throw new ApiError(502, 'GitHub did not issue the scaffold token', 'scaffold_token_failed')
  }
  return {
    ticket,
    response: {
      ticketId: ticket.id,
      token: token.token,
      ...(kitToken ? { kitToken: kitToken.token } : {}),
      expiresAt: token.expires_at,
      plan,
    },
  }
}

/** The part of `APP_LAUNCH_WORKFLOW` this needs (a structural slice, so tests pass a recorder). */
export interface LaunchWorkflowBinding {
  get(id: string): Promise<{ sendEvent(event: { type: string; payload?: unknown }): Promise<void> }>
}

export interface CompletedScaffold {
  ticket: DeployTicketRow
  /** A retried `done` for the same commit. */
  repeated: boolean
  /** Whether `SCAFFOLD_FINISHED_EVENT` reached the launch run. */
  notified: boolean
  notifyError: string | null
}

export async function completeScaffold(
  db: Database,
  workflow: LaunchWorkflowBinding | undefined,
  caller: ResolvedCaller,
  commit: string,
  now?: Date
): Promise<CompletedScaffold> {
  const { ticket, repeated } = await finishScaffoldTicket(db, caller, commit, now)
  if (!ticket.launchRunId) return { ticket, repeated, notified: false, notifyError: null }
  if (!workflow) {
    return { ticket, repeated, notified: false, notifyError: 'APP_LAUNCH_WORKFLOW is not bound' }
  }
  try {
    const instance = await workflow.get(launchInstanceOf(caller.app, ticket.launchRunId))
    await instance.sendEvent({ type: SCAFFOLD_FINISHED_EVENT, payload: { ticketId: ticket.id } })
    return { ticket, repeated, notified: true, notifyError: null }
  } catch (err) {
    return {
      ticket,
      repeated,
      notified: false,
      notifyError: err instanceof Error ? err.message : String(err),
    }
  }
}
