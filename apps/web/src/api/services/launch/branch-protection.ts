/**
 * Issue #5: Launch's branch protection — a repository RULESET named `launch`, never classic
 * protection (`docs/plans/i5-ship-to-staging.md` §1.13, CONCEPTS §18.4).
 *
 * The ruleset protects the default branch with `pull_request` (0 reviews: the review is Launch's
 * `session.merge` approval, not GitHub's), `required_status_checks` (`Gate`, the kit's CI job —
 * `KIT_REQUIRED_CHECK`), `non_fast_forward` and `deletion`, and names Launch's GitHub App as an
 * `Integration` bypass actor with `bypass_mode: 'always'`. That bypass is the point: classic
 * required checks cannot be bypassed by an App, so the release bump (a direct ref update of the
 * default branch, `releases/release.ts`) could never land under them.
 *
 * - `applyLaunchRuleset`: create or update by NAME, so it is idempotent — the `github_env` launch
 *   step (new apps) and `POST /api/apps/:id/branch-protection` (existing apps, admins) both call it.
 * - `diagnoseBranchProtection`: `ok | none | blocks | unavailable | unknown` from the rulesets that
 *   apply to the default branch (each with `current_user_can_bypass`, which GitHub answers for the
 *   App's own token) plus classic protection. Classic protection is read, never written: `blocks`
 *   tells the admin to remove it (docs/DEPLOY.md).
 *
 * A 403/404 on the rulesets API is a plan without them (a private repo outside GitHub Team):
 * `unavailable`, which the launch step records and moves past. No new App permission is needed —
 * `administration` already covers environments (`GITHUB_TOKEN_PERMISSIONS.rulesets{Read,Write}`).
 *
 * Issue #10: the same GET reports the repo's `LAUNCH_GATE_APP_ID` variable (`gateVariable`,
 * `gate-variable.ts`) and the same Apply sets it — BEFORE the ruleset, so a plan without rulesets
 * (409) still gets it — with `actions_variables` added to each token.
 */
import { type AppBranchProtection, KIT_REQUIRED_CHECK } from '@launch/shared/launch-apps'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { AppRow } from '../../../db/schema'
import { ApiError, ConflictError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from './audit'
import { diagnoseGateVariable, ensureGateVariable } from './gate-variable'
import {
  createRuleset,
  GITHUB_TOKEN_PERMISSIONS,
  GitHubApiError,
  type GitHubOptions,
  type GitHubRuleset,
  type GitHubRulesetInput,
  getBranchProtection,
  getRuleset,
  listRulesets,
  updateRuleset,
} from './github-app'
import { loadImportGitHub } from './import'
import { type RepoGitHubOptions, withRepoToken } from './releases/github'

/** The rulesets half of the diagnosis; the routes add `gateVariable`. */
export type RulesetDiagnosis = Omit<AppBranchProtection, 'gateVariable'>

/** The one ruleset Launch owns on an app's repo, found again by this name. */
export const LAUNCH_RULESET_NAME = 'launch'

/** 409 code: the repo's plan has no rulesets. */
export const RULESETS_UNAVAILABLE = 'rulesets_unavailable'

/**
 * Rule types that refuse a direct push to the branch — what the release bump is. `non_fast_forward`
 * and `deletion` do not (the bump fast-forwards); `required_linear_history` neither.
 */
const PUSH_BLOCKING_RULES = new Set([
  'pull_request',
  'required_status_checks',
  'update',
  'required_signatures',
  'required_deployments',
  'merge_queue',
  'code_scanning',
  'workflows',
])

/** What Launch writes, given its GitHub App's numeric id. */
export function launchRulesetInput(appId: number): GitHubRulesetInput {
  return {
    name: LAUNCH_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: KIT_REQUIRED_CHECK }],
        },
      },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
  }
}

/** GitHub's answer for a plan with no rulesets (or protection) on this repo. */
export function isRulesetsUnavailable(err: unknown): err is GitHubApiError {
  return err instanceof GitHubApiError && (err.status === 403 || err.status === 404)
}

function isLaunchRuleset(r: Pick<GitHubRuleset, 'name' | 'source_type'>): boolean {
  return r.name === LAUNCH_RULESET_NAME && r.source_type !== 'Organization'
}

/**
 * Create Launch's ruleset, or put it back as Launch writes it when one named `launch` exists (an
 * admin's edit is overwritten — Apply means "make it Launch's again"). A 422 on create is a
 * ruleset of that name that appeared between the list and the create: read and update it.
 * Throws `GitHubApiError` — `isRulesetsUnavailable` for a plan without rulesets.
 */
export async function applyLaunchRuleset(
  token: string,
  owner: string,
  repo: string,
  appId: number,
  opts: GitHubOptions = {}
): Promise<{ rulesetId: number; created: boolean }> {
  const input = launchRulesetInput(appId)
  const existing = (await listRulesets(token, owner, repo, opts)).find(isLaunchRuleset)
  if (existing) {
    const updated = await updateRuleset(token, owner, repo, existing.id, input, opts)
    return { rulesetId: updated.id, created: false }
  }
  try {
    const created = await createRuleset(token, owner, repo, input, opts)
    return { rulesetId: created.id, created: true }
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err
    const raced = (await listRulesets(token, owner, repo, opts)).find(isLaunchRuleset)
    if (!raced) throw err
    const updated = await updateRuleset(token, owner, repo, raced.id, input, opts)
    return { rulesetId: updated.id, created: false }
  }
}

/** `fnmatch`-style `refs/heads/…` patterns, as rulesets write them (`*` within a segment). */
function refPatternMatches(pattern: string, branch: string): boolean {
  if (pattern === '~ALL' || pattern === '~DEFAULT_BRANCH') return true
  const ref = `refs/heads/${branch}`
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${source}$`).test(ref) || pattern === branch
}

/** Whether an ACTIVE branch ruleset governs the DEFAULT branch `branch`. */
function appliesToDefaultBranch(ruleset: GitHubRuleset, branch: string): boolean {
  if (ruleset.enforcement !== 'active') return false
  if (ruleset.target && ruleset.target !== 'branch') return false
  const refName = ruleset.conditions?.ref_name
  if (!refName) return true
  return (
    refName.include.some(p => refPatternMatches(p, branch)) &&
    !refName.exclude.some(p => refPatternMatches(p, branch))
  )
}

function requiredChecksOf(ruleset: GitHubRuleset): string[] {
  const out: string[] = []
  for (const rule of ruleset.rules ?? []) {
    if (rule.type !== 'required_status_checks') continue
    const list = rule.parameters?.required_status_checks
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const context = (item as { context?: unknown }).context
      if (typeof context === 'string') out.push(context)
    }
  }
  return out
}

function canBypass(ruleset: GitHubRuleset): boolean {
  return (
    ruleset.current_user_can_bypass === 'always' || ruleset.current_user_can_bypass === 'exempt'
  )
}

const unknown = (detail: string): AppBranchProtection => ({
  state: 'unknown',
  requiredChecks: [],
  appCanBypass: false,
  rulesetId: null,
  detail,
  gateVariable: null,
})

const unknownRules = (detail: string): RulesetDiagnosis => {
  const { gateVariable: _, ...rules } = unknown(detail)
  return rules
}

/**
 * How the default branch is protected, read with a token for the App itself, so
 * `current_user_can_bypass` is the App's own answer.
 */
export async function diagnoseBranchProtection(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  opts: GitHubOptions = {}
): Promise<RulesetDiagnosis> {
  let listed: GitHubRuleset[]
  try {
    listed = await listRulesets(token, owner, repo, opts)
  } catch (err) {
    if (isRulesetsUnavailable(err)) {
      return {
        state: 'unavailable',
        requiredChecks: [],
        appCanBypass: true,
        rulesetId: null,
        detail: `GitHub has no rulesets for ${owner}/${repo} (${err.message}). A private repository needs GitHub Team or above; nothing protects ${branch}.`,
      }
    }
    return unknownRules(`GitHub could not list the rulesets: ${(err as Error).message}`)
  }

  const blockers: string[] = []
  const requiredChecks = new Set<string>()
  let rulesetId: number | null = null
  try {
    for (const item of listed) {
      if (isLaunchRuleset(item)) rulesetId = item.id
      if (item.enforcement !== 'active') continue
      // The list omits `rules` (and may omit the conditions): read each active one in full.
      const ruleset = (await getRuleset(token, owner, repo, item.id, opts)) ?? null
      if (!ruleset || !appliesToDefaultBranch(ruleset, branch)) continue
      for (const check of requiredChecksOf(ruleset)) requiredChecks.add(check)
      const blocking = (ruleset.rules ?? []).some(r => PUSH_BLOCKING_RULES.has(r.type))
      if (blocking && !canBypass({ ...item, ...ruleset })) {
        blockers.push(
          `The ruleset “${ruleset.name}” refuses direct pushes to ${branch} and Launch's GitHub App may not bypass it, so a release cannot bump the version: add the App as a bypass actor (always), or remove the ruleset and press Apply.`
        )
      }
    }
  } catch (err) {
    return unknownRules(`GitHub could not read a ruleset: ${(err as Error).message}`)
  }

  try {
    const classic = await getBranchProtection(token, owner, repo, branch, opts)
    const checks = [
      ...(classic?.required_status_checks?.contexts ?? []),
      ...(classic?.required_status_checks?.checks ?? []).map(c => c.context),
    ]
    for (const check of checks) requiredChecks.add(check)
    if (classic && (checks.length > 0 || classic.required_pull_request_reviews)) {
      blockers.push(
        `${branch} has classic branch protection, which no GitHub App can bypass, so a release cannot bump the version: remove it in the repository's Settings › Branches, then press Apply to protect it with Launch's ruleset instead.`
      )
    }
  } catch (err) {
    // A plan without classic protection answers like one without rulesets: there is none.
    if (!isRulesetsUnavailable(err)) {
      return unknownRules(`GitHub could not read the branch protection: ${(err as Error).message}`)
    }
  }

  const checks = [...requiredChecks].sort()
  if (blockers.length > 0) {
    return {
      state: 'blocks',
      requiredChecks: checks,
      appCanBypass: false,
      rulesetId,
      detail: blockers.join(' '),
    }
  }
  if (requiredChecks.has(KIT_REQUIRED_CHECK)) {
    return { state: 'ok', requiredChecks: checks, appCanBypass: true, rulesetId, detail: null }
  }
  return {
    state: 'none',
    requiredChecks: checks,
    appCanBypass: true,
    rulesetId,
    detail: `Nothing on GitHub requires the ${KIT_REQUIRED_CHECK} check on ${branch}, so a pull request can merge with CI red. Apply adds Launch's ruleset.`,
  }
}

/**
 * `GET /api/apps/:id/branch-protection`: the diagnosis (with the gate variable's), or `unknown`
 * with the reason when GitHub cannot be asked at all (no repository, no App, the App not installed
 * on the owner).
 */
export async function getAppBranchProtection(
  db: Database,
  cfg: AppConfig,
  app: Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>,
  opts: RepoGitHubOptions = {}
): Promise<AppBranchProtection> {
  if (!app.repoOwner || !app.repoName) return unknown('This app has no repository.')
  try {
    const github = opts.github ?? (await loadImportGitHub(db, cfg))
    return await withRepoToken(
      db,
      cfg,
      app,
      { ...GITHUB_TOKEN_PERMISSIONS.rulesetsRead, ...GITHUB_TOKEN_PERMISSIONS.gateVariableRead },
      async (token, repo) => ({
        ...(await diagnoseBranchProtection(token, repo.owner, repo.repo, repo.branch, opts)),
        gateVariable: await diagnoseGateVariable(
          token,
          repo.owner,
          repo.repo,
          github.auth.appId,
          opts
        ),
      }),
      { ...opts, github }
    )
  } catch (err) {
    return unknown((err as Error).message)
  }
}

/**
 * `POST /api/apps/:id/branch-protection` (admins): set the `LAUNCH_GATE_APP_ID` variable (issue
 * #10), apply Launch's ruleset, then answer the fresh diagnosis — still `blocks` while classic
 * protection remains, which Launch never removes. Audited
 * `app.branch_protection.applied`. 409 `rulesets_unavailable` on a plan without rulesets, 502
 * `branch_protection_github_failed` for anything else GitHub refused.
 */
export async function applyAppBranchProtection(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'repoOwner' | 'repoName' | 'defaultBranch'>,
  actor: AuditActor,
  opts: RepoGitHubOptions = {}
): Promise<AppBranchProtection> {
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const appId = Number(github.auth.appId)
  const { applied, protection, gateVariable } = await withRepoToken(
    db,
    cfg,
    app,
    { ...GITHUB_TOKEN_PERMISSIONS.rulesetsWrite, ...GITHUB_TOKEN_PERMISSIONS.gateVariableWrite },
    async (token, repo) => {
      try {
        // First, so a plan without rulesets (the 409 below) still gets the variable.
        const gateVariable = await ensureGateVariable(token, repo.owner, repo.repo, appId, opts)
        const applied = await applyLaunchRuleset(token, repo.owner, repo.repo, appId, opts)
        const protection: AppBranchProtection = {
          ...(await diagnoseBranchProtection(token, repo.owner, repo.repo, repo.branch, opts)),
          gateVariable: await diagnoseGateVariable(token, repo.owner, repo.repo, appId, opts),
        }
        return { applied, protection, gateVariable }
      } catch (err) {
        if (isRulesetsUnavailable(err)) {
          throw new ConflictError(
            `GitHub has no rulesets for ${repo.owner}/${repo.repo} (${err.message}). A private repository needs GitHub Team or above.`,
            RULESETS_UNAVAILABLE
          )
        }
        if (err instanceof GitHubApiError) {
          throw new ApiError(
            502,
            `GitHub refused the ruleset: ${err.message}`,
            'branch_protection_github_failed'
          )
        }
        throw err
      }
    },
    { ...opts, github }
  )
  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'app.branch_protection.applied',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    // `before` is only whether a `launch` ruleset existed: Apply rewrites it whatever it held.
    summary: {
      before: { rulesetId: applied.created ? null : applied.rulesetId },
      after: {
        rulesetId: applied.rulesetId,
        requiredChecks: [KIT_REQUIRED_CHECK],
        bypassAppId: appId,
        state: protection.state,
        gateVariable,
      },
    },
  })
  return protection
}
