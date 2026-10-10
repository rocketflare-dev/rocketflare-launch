/**
 * The DYNAMIC conformance check (D36 K3, `docs/plans/multi-kit.md` §7): a kit's static check
 * reads files; this one RUNS the kit. The scaffold job Launch generates from the kit's manifest
 * (`scaffold/job.ts`) runs against a throwaway private repo in the apps organisation —
 * `launch-kit-check-<kit slug>-<check id>` — exactly as for a new app: init, kitOnly, the app
 * manifest, postInit, the default plugins, the gate's lint and typecheck. Launch then reads the
 * copy's app manifest and tomls through the kit's adapter (`adapter.scaffold.problems`: the app,
 * the kit version and commit, every name by the naming rule, only provisionable bindings) and
 * removes the repo. A kit is `verified` when its static check passed and no dynamic check at the
 * same pin failed; while one runs it is `checking`.
 *
 * **Long work, so it is a job** (`kit.check` on `JOBS_QUEUE`, "routes enqueue, never run"):
 *
 * - `start` ({@link startDynamicCheck} enqueues it, the kit row `checking`): create the repo
 *   (recording its GitHub id at once — the `/ci/kit-check` caller is matched by it), commit the
 *   job's two files with `endpoint: '/ci/kit-check'`, dispatch it (`GitHubActionsScaffoldRunner`;
 *   GitHub not having registered the workflow yet is a retry), then enqueue `poll`.
 * - `poll`, every {@link KIT_CHECK_POLL_SECONDS}: the job reported its commit → `finish`; its run
 *   failed, or {@link KIT_CHECK_TIMEOUT_MS} passed → `finish` as failed; else poll again.
 * - `finish`: check the copy (when the job pushed one), delete the repo — ARCHIVE it when the App
 *   may not delete (403/404), and say so — and write the result by compare-and-set on the check's
 *   id. Audited `kit.checked` with the dynamic result.
 *
 * **Superseded checks clean up.** A re-pin clears `dynamic_check`, and a new check replaces it;
 * every write is a compare-and-set on the check's id, so an old check's phases find another id —
 * and still remove the repo they created (its name rides in the job payload).
 *
 * **The job's token** (`/ci/kit-check/token`, {@link issueKitCheckToken}) is the app scaffold's
 * twin: a verified OIDC token whose `repository_id` is the running check's repo, from
 * `launch-scaffold.yml` on `main`, gets ONCE a one-hour token for that repo (`contents` +
 * `workflows` write), a kit read token when the kit is private (`mintKitReadToken`), and a plan
 * for the slug `kit-check`. `/ci/kit-check/done` records the pushed commit and enqueues `finish`.
 */
import type { KitCheckPayload } from '@launch/shared/jobs'
import type { KitDynamicCheck } from '@launch/shared/kits'
import type { ScaffoldPlan, ScaffoldTokenResponse } from '@launch/shared/launch-pipeline'
import type { TemplatePin } from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ApiError, ConflictError, ForbiddenError } from '../../../utils/core/errors'
import { enqueueJob, type JobsQueue } from '../../jobs'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../audit'
import type { GitHubOidcClaims } from '../ci/github-oidc'
import {
  archiveRepo,
  commitFilesIfChanged,
  createOrgRepo,
  deleteRepo,
  GitHubApiError,
  getRepo,
} from '../github-app'
import { issuerOf } from '../oidc-clients'
import { loadPipelineVendors, type PipelineVendors } from '../pipeline/context'
import { orgToken, readRepoFiles, repoToken } from '../pipeline/provision-github'
import { GitHubActionsScaffoldRunner } from '../scaffold/github-actions-runner'
import {
  SCAFFOLD_JOB_COMMIT_MESSAGES,
  SCAFFOLD_WORKFLOW_FILE,
  scaffoldFiles,
} from '../scaffold/job'
import { ScaffoldNotReadyError } from '../scaffold/runner'
import { mintKitReadToken, SCAFFOLD_TOKEN_PERMISSIONS } from '../scaffold/service'
import { kitManifestOf, manifestAdapter } from './adapter'
import {
  claimKitCheckToken,
  compareAndSetDynamicCheck,
  findKitByCheckRepoId,
  getKit,
  type KitDynamicCheckRecord,
  type KitRow,
} from './store'

/** The app the throwaway copy is initialised as. */
export const KIT_CHECK_SLUG = 'kit-check'
export const KIT_CHECK_DISPLAY_NAME = 'Kit check'
/** The domain a check's copy gets when Launch has no apps domain set yet. */
export const KIT_CHECK_FALLBACK_DOMAIN = 'example.com'
/** How often `poll` looks at the job. */
export const KIT_CHECK_POLL_SECONDS = 60
/** The job's own timeout is 30 minutes; this leaves room for a queued runner. */
export const KIT_CHECK_TIMEOUT_MS = 45 * 60_000
export const KIT_CHECK_REPO_PREFIX = 'launch-kit-check-'

/** `launch-kit-check-<slug>-<first 8 of the check id>` (GitHub allows 100 characters). */
export function kitCheckRepoName(slug: string, checkId: string): string {
  return `${KIT_CHECK_REPO_PREFIX}${slug}-${checkId.slice(0, 8)}`
}

/** The API's view of a stored check (`kitDynamicCheckSchema`), or null. */
export function publicDynamicCheck(
  record: KitDynamicCheckRecord | null | undefined
): KitDynamicCheck | null {
  if (!record) return null
  return {
    id: record.id,
    status: record.status,
    commit: record.commit,
    repo: record.repo ?? null,
    runUrl: record.runUrl ?? null,
    problems: record.problems ?? [],
    cleanup: record.cleanup ?? null,
    startedAt: new Date(record.startedAt),
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
  }
}

/** What the static check found, as columns. */
export interface StaticResult {
  status: 'verified' | 'failed'
  problems: string[]
}

/**
 * The kit's status after a STATIC check at `commit`: failed when it failed; else `checking` while
 * a dynamic check at that commit runs, `failed` (with its problems) when one there failed, and
 * `verified` otherwise.
 */
export function statusAfterStatic(
  inspection: StaticResult,
  dynamic: KitDynamicCheckRecord | null | undefined,
  commit: string
): { status: KitRow['status']; problems: string[] } {
  if (inspection.status !== 'verified') return inspection
  if (!dynamic || dynamic.commit !== commit) return inspection
  if (dynamic.status === 'queued' || dynamic.status === 'running') {
    return { status: 'checking', problems: inspection.problems }
  }
  if (dynamic.status === 'failed') {
    return {
      status: 'failed',
      problems: [...inspection.problems, ...dynamic.problems.map(dynamicProblem)],
    }
  }
  return inspection
}

const dynamicProblem = (p: string) => `Dynamic check: ${p}`

export interface StartDynamicCheckInput {
  db: Database
  queue: JobsQueue | undefined
  kit: KitRow
  pin: TemplatePin
  auditTenantId: string
  actor: AuditActor
  now?: Date
}

/**
 * Start a dynamic check of `kit` at `pin` (the caller ran the static check and it passed): a new
 * check replaces any earlier one (whose phases then only clean up), the kit is `checking`, and
 * the `start` phase is enqueued. Returns the row after.
 */
export async function startDynamicCheck(input: StartDynamicCheckInput): Promise<KitRow> {
  const { db, kit, pin } = input
  const now = input.now ?? new Date()
  const record: KitDynamicCheckRecord = {
    id: crypto.randomUUID(),
    status: 'queued',
    commit: pin.commit,
    kitRepo: pin.repo,
    tag: pin.tag ?? null,
    repo: null,
    repoId: null,
    runId: null,
    runUrl: null,
    dispatchedAt: null,
    tokenIssuedAt: null,
    scaffoldCommit: null,
    problems: [],
    cleanup: null,
    startedAt: now.toISOString(),
    finishedAt: null,
    auditTenantId: input.auditTenantId,
    actorUserId: input.actor.actorUserId ?? null,
  }
  const row = await compareAndSetDynamicCheck(db, kit.id, null, record, { status: 'checking' })
  if (!row) throw new ConflictError(`No kit ${kit.slug}`, 'kit_not_found')
  try {
    await enqueueJob(input.queue, {
      type: 'kit.check',
      payload: { kitId: kit.id, checkId: record.id, phase: 'start' },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await compareAndSetDynamicCheck(
      db,
      kit.id,
      record.id,
      {
        ...record,
        status: 'failed',
        problems: [`could not be queued: ${reason}`],
        finishedAt: now.toISOString(),
      },
      { status: 'failed', problems: [dynamicProblem(`could not be queued: ${reason}`)] }
    )
    throw err
  }
  return row
}

// ---- the job ----------------------------------------------------------------------------------------

export interface KitCheckDeps {
  db: Database
  cfg: AppConfig
  /** `JOBS_QUEUE` — the next phase is enqueued on it. */
  queue?: JobsQueue
  /** The platform's GitHub (and apps domain); tests hand vendors in. */
  vendors?: () => Promise<PipelineVendors>
  now?: () => Date
}

function vendorsOf(deps: KitCheckDeps): Promise<PipelineVendors> {
  return deps.vendors ? deps.vendors() : loadPipelineVendors(deps.db, deps.cfg)
}

const nowOf = (deps: KitCheckDeps) => (deps.now ?? (() => new Date()))()

/** The check `payload` names, when the kit row still holds it. */
async function currentCheck(
  db: Database,
  payload: KitCheckPayload
): Promise<{ kit: KitRow; check: KitDynamicCheckRecord } | null> {
  const kit = await getKit(db, payload.kitId)
  const check = kit?.dynamicCheck
  if (!kit || !check || check.id !== payload.checkId) return null
  return { kit, check }
}

async function next(
  deps: KitCheckDeps,
  payload: KitCheckPayload,
  phase: KitCheckPayload['phase'],
  repo: string | null,
  delaySeconds?: number
): Promise<void> {
  await enqueueJob(
    deps.queue,
    {
      type: 'kit.check',
      payload: {
        kitId: payload.kitId,
        checkId: payload.checkId,
        phase,
        ...(repo ? { repo } : {}),
      },
    },
    delaySeconds ? { delaySeconds } : {}
  )
}

/** One `kit.check` job: the phase it names (see the header). */
export async function runKitCheckJob(deps: KitCheckDeps, payload: KitCheckPayload): Promise<void> {
  const current = await currentCheck(deps.db, payload)
  if (!current) {
    // Superseded (a re-pin, a newer check): nothing to record, but its repo must not linger.
    if (payload.repo) await cleanupRepo(deps, payload.repo)
    return
  }
  if (payload.phase === 'start') return startPhase(deps, payload, current.kit, current.check)
  if (payload.phase === 'poll') return pollPhase(deps, payload, current.kit, current.check)
  // A second `finish` (the poll and /done both enqueue one) finds the check over.
  if (current.check.status !== 'running') return
  return finishPhase(deps, current.kit, current.check, null)
}

async function startPhase(
  deps: KitCheckDeps,
  payload: KitCheckPayload,
  kit: KitRow,
  check: KitDynamicCheckRecord
): Promise<void> {
  if (check.status !== 'queued' && !(check.status === 'running' && !check.dispatchedAt)) return
  const vendors = await vendorsOf(deps)
  if (!vendors.github) {
    return finishPhase(deps, kit, check, [
      'Connect the GitHub App (and its organisation) in Setup: the check runs in a repository there',
    ])
  }
  const manifest = kitManifestOf(kit)
  const name = kitCheckRepoName(kit.slug, check.id)
  let current = check
  try {
    const { token, org } = await orgToken(vendors, {
      administration: 'write',
      contents: 'write',
      metadata: 'read',
    })
    let repo = await getRepo(token, org, name)
    // A repo of this check's name with another id is not ours; with no id recorded yet it is the
    // one an earlier attempt of this phase created (the name carries the check's id).
    if (repo && current.repoId && String(repo.id) !== current.repoId) {
      return finishPhase(deps, kit, current, [
        `A repository named ${org}/${name} already exists and this check did not create it`,
      ])
    }
    if (!repo) {
      repo = await createOrgRepo(token, org, {
        name,
        description: `Launch's dynamic conformance check of ${kit.name} — removed when the check ends`,
        private: true,
        autoInit: true,
      })
    }
    current = {
      ...current,
      status: 'running',
      repo: repo.full_name,
      repoId: String(repo.id),
    }
    if (!(await compareAndSetDynamicCheck(deps.db, kit.id, check.id, current))) {
      await cleanupRepo(deps, repo.full_name)
      return
    }
    const write = await repoToken(vendors, name, { contents: 'write', workflows: 'write' })
    await commitFilesIfChanged(
      write.token,
      org,
      name,
      repo.default_branch ?? 'main',
      scaffoldFiles(manifest, { endpoint: '/ci/kit-check' }),
      SCAFFOLD_JOB_COMMIT_MESSAGES.add
    )
    const actions = await repoToken(vendors, name, { actions: 'write', contents: 'read' })
    const plan = await kitCheckPlan(vendors, current, manifest.kit.id, repo.full_name)
    const ids = await new GitHubActionsScaffoldRunner().start(
      { token: actions.token, owner: org, repo: name, launchUrl: issuerOf(deps.cfg) },
      plan
    )
    current = {
      ...current,
      dispatchedAt: ids.dispatchedAt ?? nowOf(deps).toISOString(),
      runId: ids.runId ?? null,
    }
    if (!(await compareAndSetDynamicCheck(deps.db, kit.id, check.id, current))) {
      await cleanupRepo(deps, repo.full_name)
      return
    }
  } catch (err) {
    // GitHub has not registered the workflow file it was just sent: the queue retries the phase.
    if (err instanceof ScaffoldNotReadyError) throw err
    return finishPhase(deps, kit, current, [
      `could not start: ${err instanceof Error ? err.message : String(err)}`,
    ])
  }
  await next(deps, payload, 'poll', current.repo, KIT_CHECK_POLL_SECONDS)
}

async function pollPhase(
  deps: KitCheckDeps,
  payload: KitCheckPayload,
  kit: KitRow,
  check: KitDynamicCheckRecord
): Promise<void> {
  if (check.status !== 'running') return
  if (check.scaffoldCommit) return finishPhase(deps, kit, check, null)
  const repoName = check.repo?.split('/')[1]
  if (!repoName || !check.dispatchedAt)
    return finishPhase(deps, kit, check, ['the job was never dispatched'])
  const vendors = await vendorsOf(deps)
  const actions = await repoToken(vendors, repoName, { actions: 'read', contents: 'read' })
  const state = await new GitHubActionsScaffoldRunner().poll(
    {
      token: actions.token,
      owner: actions.owner,
      repo: repoName,
      ...(deps.now ? { now: deps.now } : {}),
    },
    { dispatchedAt: check.dispatchedAt, ...(check.runId ? { runId: check.runId } : {}) }
  )
  let current = check
  if (state.runId && (state.runId !== check.runId || (state.url && !check.runUrl))) {
    current = { ...check, runId: state.runId, runUrl: state.url ?? check.runUrl }
    if (!(await compareAndSetDynamicCheck(deps.db, kit.id, check.id, current))) return
  }
  if (state.status === 'failed') {
    return finishPhase(deps, kit, current, [
      `the scaffold job failed${state.detail ? `: ${state.detail}` : ''}${current.runUrl ? ` (${current.runUrl})` : ''}`,
    ])
  }
  if (state.status === 'succeeded') {
    // The job reports its commit before it ends: read the row once more for it.
    const fresh = await currentCheck(deps.db, payload)
    if (fresh?.check.scaffoldCommit) return finishPhase(deps, fresh.kit, fresh.check, null)
    return finishPhase(deps, kit, current, ['the job ended without reporting its commit to Launch'])
  }
  const elapsed = nowOf(deps).getTime() - new Date(check.startedAt).getTime()
  if (elapsed > KIT_CHECK_TIMEOUT_MS) {
    return finishPhase(deps, kit, current, [
      `the scaffold job did not finish within ${KIT_CHECK_TIMEOUT_MS / 60_000} minutes`,
    ])
  }
  await next(deps, payload, 'poll', current.repo, KIT_CHECK_POLL_SECONDS)
}

/** The copy the job pushed, checked through the kit's adapter. */
async function copyProblems(
  vendors: PipelineVendors,
  kit: KitRow,
  check: KitDynamicCheckRecord
): Promise<string[]> {
  const repoName = check.repo?.split('/')[1]
  if (!repoName || !check.scaffoldCommit) return ['the job pushed no copy']
  const adapter = manifestAdapter(kitManifestOf(kit))
  const { manifest: manifestPath, tomls } = adapter.paths
  const read = await repoToken(vendors, repoName, { contents: 'read' })
  const files = await readRepoFiles(
    read.token,
    read.owner,
    repoName,
    [manifestPath, tomls.production, tomls.staging],
    check.scaffoldCommit
  )
  const missing = [manifestPath, tomls.production, tomls.staging].filter(p => !files[p])
  if (missing.length) return missing.map(p => `the copy has no ${p}`)
  return adapter.scaffold.problems(
    {
      manifest: files[manifestPath] ?? '',
      production: files[tomls.production] ?? '',
      staging: files[tomls.staging] ?? '',
    },
    { slug: KIT_CHECK_SLUG, tag: check.tag, commit: check.commit }
  )
}

/**
 * The end of a check: `failure` (sentences) when it failed before a copy existed, else null and
 * the copy is checked. The repo is removed, the result written (compare-and-set) and audited.
 */
async function finishPhase(
  deps: KitCheckDeps,
  kit: KitRow,
  check: KitDynamicCheckRecord,
  failure: string[] | null
): Promise<void> {
  let problems = failure ?? []
  if (!failure) {
    try {
      problems = await copyProblems(await vendorsOf(deps), kit, check)
    } catch (err) {
      problems = [`could not read the copy: ${err instanceof Error ? err.message : String(err)}`]
    }
  }
  const cleanup = check.repo ? await cleanupRepo(deps, check.repo) : null
  const passed = problems.length === 0
  const done: KitDynamicCheckRecord = {
    ...check,
    status: passed ? 'passed' : 'failed',
    problems,
    cleanup,
    finishedAt: nowOf(deps).toISOString(),
  }
  // The static result stands (the check started only after it passed); the dynamic one decides.
  const staticProblems = (kit.problems ?? []).filter(p => !p.startsWith('Dynamic check: '))
  const after = await compareAndSetDynamicCheck(
    deps.db,
    kit.id,
    check.id,
    done,
    {
      status: passed ? 'verified' : 'failed',
      problems: passed ? staticProblems : [...staticProblems, ...problems.map(dynamicProblem)],
    },
    // Only the first finish writes: the poll's and the one /done enqueued may race.
    check.status
  )
  if (!after) return
  await recordAudit(deps.db, {
    tenantId: check.auditTenantId,
    ...SYSTEM_ACTOR,
    action: 'kit.checked',
    targetType: 'Kit',
    targetId: kit.id,
    summary: {
      after: {
        status: after.status,
        dynamic: {
          id: check.id,
          status: done.status,
          commit: check.commit,
          repo: check.repo,
          runUrl: check.runUrl,
          cleanup,
          problems,
          requestedBy: check.actorUserId,
        },
      },
    },
  })
}

/**
 * Delete the throwaway repo; when the App may not (403, or 404 for a token that cannot see the
 * delete), archive it instead. `failed` when neither worked — the repo's name is on the check.
 */
async function cleanupRepo(
  deps: KitCheckDeps,
  fullName: string
): Promise<'deleted' | 'archived' | 'failed'> {
  const [owner = '', name = ''] = fullName.split('/')
  if (!name.startsWith(KIT_CHECK_REPO_PREFIX)) return 'failed'
  try {
    const vendors = await vendorsOf(deps)
    const { token } = await orgToken(vendors, { administration: 'write', metadata: 'read' })
    try {
      await deleteRepo(token, owner, name)
      return 'deleted'
    } catch (err) {
      if (!(err instanceof GitHubApiError) || (err.status !== 403 && err.status !== 404)) throw err
      if (err.status === 404 && !(await getRepo(token, owner, name))) return 'deleted'
      await archiveRepo(token, owner, name)
      return 'archived'
    }
  } catch {
    return 'failed'
  }
}

// ---- /ci/kit-check ------------------------------------------------------------------------------------

/** A verified OIDC token resolved to the kit whose running check owns its repository. */
export interface KitCheckCaller {
  kit: KitRow
  check: KitDynamicCheckRecord
  claims: GitHubOidcClaims
}

function refuse(message: string): never {
  throw new ForbiddenError(message, 'ci_caller_refused')
}

/**
 * The `/ci/kit-check` caller: the running check whose repo has the token's `repository_id`, the
 * token's `repository` its recorded name, from `launch-scaffold.yml` on `main` — else a 403.
 */
export async function resolveKitCheckCaller(
  db: Database,
  claims: GitHubOidcClaims
): Promise<KitCheckCaller> {
  const kit = await findKitByCheckRepoId(db, claims.repository_id)
  const check = kit?.dynamicCheck
  if (!kit || !check || check.status !== 'running') {
    refuse('This repository is not a kit check Launch is running')
  }
  if (!check.repo || check.repo.toLowerCase() !== claims.repository.toLowerCase()) {
    refuse(`The token's repository ${claims.repository} is not the check's repository`)
  }
  const prefix = `${claims.repository}/.github/workflows/${SCAFFOLD_WORKFLOW_FILE}@`
  if (!claims.job_workflow_ref.startsWith(prefix)) {
    refuse(`Only ${SCAFFOLD_WORKFLOW_FILE} may call this (the job ran ${claims.job_workflow_ref})`)
  }
  if (claims.ref !== 'refs/heads/main') {
    refuse(`Only refs/heads/main may call this (the job ran on ${claims.ref})`)
  }
  return { kit, check, claims }
}

/** The plan a check's job builds: the kit at the check's pin, as the app `kit-check`. */
async function kitCheckPlan(
  vendors: PipelineVendors,
  check: KitDynamicCheckRecord,
  kitId: string,
  repo: string
): Promise<ScaffoldPlan> {
  return {
    slug: KIT_CHECK_SLUG,
    displayName: KIT_CHECK_DISPLAY_NAME,
    domain: vendors.settings.appsDomain ?? KIT_CHECK_FALLBACK_DOMAIN,
    repo,
    kitRepo: check.kitRepo,
    tag: check.tag,
    commit: check.commit,
    kitId,
  }
}

/**
 * `/ci/kit-check/token`: claim the check's one token (409 `scaffold_token_unavailable` after),
 * then the push token, the kit read token (a private kit) and the plan. Never stored or logged.
 */
export async function issueKitCheckToken(
  deps: KitCheckDeps,
  caller: KitCheckCaller
): Promise<ScaffoldTokenResponse> {
  const claimed = await claimKitCheckToken(deps.db, caller.kit.id, caller.check.id, nowOf(deps))
  if (!claimed?.dynamicCheck) {
    throw new ConflictError(
      'This kit check already had its token, or is no longer running',
      'scaffold_token_unavailable'
    )
  }
  const check = claimed.dynamicCheck
  const vendors = await vendorsOf(deps)
  const repoName = check.repo?.split('/')[1] ?? ''
  try {
    const github = vendors.github
    if (!github) throw new Error('The GitHub App is not connected')
    const push = await repoToken(vendors, repoName, { ...SCAFFOLD_TOKEN_PERMISSIONS })
    const kitToken = await mintKitReadToken(github, check.kitRepo, {})
    const plan = await kitCheckPlan(vendors, check, kitManifestOf(claimed).kit.id, check.repo ?? '')
    return {
      ticketId: check.id,
      token: push.token,
      ...(kitToken ? { kitToken: kitToken.token } : {}),
      // repoToken does not surface GitHub's expiry: an installation token lives one hour.
      expiresAt: new Date(nowOf(deps).getTime() + 60 * 60_000).toISOString(),
      plan,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await finishPhase(deps, claimed, check, [`could not mint the job's token: ${reason}`])
    throw new ApiError(502, 'GitHub did not issue the kit check token', 'scaffold_token_failed')
  }
}

/**
 * `/ci/kit-check/done`: record the commit the job pushed (idempotent for the same one) and enqueue
 * `finish`. A different commit is a 409.
 */
export async function completeKitCheck(
  deps: Pick<KitCheckDeps, 'db' | 'queue'>,
  caller: KitCheckCaller,
  commit: string
): Promise<{ checkId: string; repeated: boolean }> {
  const { kit, check } = caller
  if (check.scaffoldCommit) {
    if (check.scaffoldCommit === commit) return { checkId: check.id, repeated: true }
    throw new ConflictError(
      `The kit check already recorded commit ${check.scaffoldCommit}`,
      'scaffold_ticket_not_open'
    )
  }
  const after = await compareAndSetDynamicCheck(deps.db, kit.id, check.id, {
    ...check,
    scaffoldCommit: commit,
  })
  if (!after)
    throw new ConflictError('The kit check is no longer running', 'scaffold_ticket_not_open')
  await enqueueJob(deps.queue, {
    type: 'kit.check',
    payload: {
      kitId: kit.id,
      checkId: check.id,
      phase: 'finish',
      ...(check.repo ? { repo: check.repo } : {}),
    },
  })
  return { checkId: check.id, repeated: false }
}
