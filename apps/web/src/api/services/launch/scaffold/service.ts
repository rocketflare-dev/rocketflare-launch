/**
 * What `/ci/scaffold/*` does once the caller is proven (`routes/ci-scaffold.ts` verifies the OIDC
 * token and resolves the caller first):
 *
 * - `issueScaffoldToken` — the plan (the app's names, the apps domain and the pinned kit), then the
 *   ticket CLAIM (compare-and-set: a second call is a 409), then a one-hour installation token
 *   narrowed to the ONE repo and `contents` + `workflows` write. The plan is built before the claim
 *   so a missing setting does not burn the ticket; a failed mint after the claim marks the ticket
 *   `failed`, and the launch run's retry opens a new one. The token is returned once and never
 *   stored or audited.
 * - `completeScaffold` — the ticket `finished` with the pushed commit, then `SCAFFOLD_FINISHED_EVENT`
 *   to the launch run's Workflow instance. The row is the truth: an event that cannot be delivered
 *   is logged, not failed, and the run's wait falls back to reading the ticket.
 */
import {
  SCAFFOLD_FINISHED_EVENT,
  type ScaffoldPlan,
  type ScaffoldTokenResponse,
} from '@launch/shared/launch-pipeline'
import {
  DEFAULT_TEMPLATE_PIN,
  type TemplatePin,
  templatePinSchema,
} from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { DeployTicketRow } from '../../../../db/schema'
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
import { launchInstanceOf } from '../pipeline/instance'
import { claimScaffoldTicket, failScaffoldTicket, finishScaffoldTicket } from './tickets'

/** The permissions the scaffold job's token carries — and nothing else. */
export const SCAFFOLD_TOKEN_PERMISSIONS = { contents: 'write', workflows: 'write' } as const

/** The kit a new app is cut from: `launch_settings.template_pin`, else kit 0.15.0. */
export async function resolveTemplatePin(db: Database): Promise<TemplatePin> {
  const parsed = templatePinSchema.safeParse(await getSetting(db, 'template_pin'))
  return parsed.success ? parsed.data : DEFAULT_TEMPLATE_PIN
}

/** The scaffold plan for the caller's app. No secret. */
export async function scaffoldPlanFor(db: Database, caller: ResolvedCaller): Promise<ScaffoldPlan> {
  const domain = await getSetting<string>(db, 'apps_domain')
  if (typeof domain !== 'string' || domain.trim() === '') {
    throw new ConflictError('Set the apps domain in Setup first', 'apps_domain_not_configured')
  }
  const pin = await resolveTemplatePin(db)
  const { app } = caller
  return {
    slug: app.slug,
    displayName: app.displayName,
    domain: domain.trim().toLowerCase(),
    repo: `${app.repoOwner}/${app.repoName}`,
    kitRepo: pin.repo,
    tag: pin.tag,
    commit: pin.commit,
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
  const plan = await scaffoldPlanFor(db, caller)
  const github = opts.github ?? (await loadImportGitHub(db, cfg))

  const ticket = await claimScaffoldTicket(db, caller, opts.now)
  if (!ticket) {
    throw new ConflictError(
      'No scaffold is waiting for this repository, or its token was already issued',
      'scaffold_token_unavailable'
    )
  }

  const ghOpts: GitHubOptions = { fetch: opts.fetch, apiBase: opts.apiBase }
  let token: { token: string; expires_at: string }
  try {
    const installationId = await installationFor(github, caller.app.repoOwner ?? '', ghOpts)
    token = await installationToken(
      github.auth,
      installationId,
      { repositories: [caller.app.repoName ?? ''], permissions: { ...SCAFFOLD_TOKEN_PERMISSIONS } },
      ghOpts
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'GitHub refused the installation token'
    await failScaffoldTicket(db, ticket, `Could not mint the scaffold token: ${reason}`)
    throw new ApiError(502, 'GitHub did not issue the scaffold token', 'scaffold_token_failed')
  }
  return {
    ticket,
    response: { ticketId: ticket.id, token: token.token, expiresAt: token.expires_at, plan },
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
