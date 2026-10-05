/**
 * Issue #10: the `LAUNCH_GATE_APP_ID` repository Actions variable on an app's repo (CONCEPTS §18.13).
 *
 * The kit's `verified` CI job runs only when the variable is set, and then trusts only a
 * `launch/gate` check run (issue #9, `sessions/gate-attest.ts`) posted by the GitHub App whose
 * numeric id it holds — so the value is Launch's own App id (`github_app` credential, `appId`). A
 * kit without the job never reads it: setting it is harmless there.
 *
 * - {@link ensureGateVariable}: read, then write only when it differs (`unchanged` costs no write).
 *   Called by the `github_env` launch step (new apps), Apply on the branch-protection card
 *   (`POST /api/apps/:id/branch-protection`, existing and imported apps) and the start of a kit
 *   upgrade ({@link ensureAppGateVariable}, best-effort — the upgrade that brings the job in).
 * - {@link diagnoseGateVariable}: `ok | missing | wrong | unknown`, reported beside the
 *   branch-protection diagnosis (`gateVariable`).
 *
 * Detaching an app is deleting the variable in the repo's settings: CI then runs the full gate on
 * every push, as it did before Launch. Launch has no detach flow that removes it.
 */
import { type AppGateVariable, LAUNCH_GATE_APP_ID_VARIABLE } from '@launch/shared/launch-apps'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { AppRow } from '../../../db/schema'
import {
  GITHUB_TOKEN_PERMISSIONS,
  type GitHubOptions,
  getRepoVariable,
  upsertRepoVariable,
} from './github-app'
import { loadImportGitHub } from './import'
import { type RepoGitHubOptions, withRepoToken } from './releases/github'

export { LAUNCH_GATE_APP_ID_VARIABLE }

export type GateVariableWrite = 'created' | 'updated' | 'unchanged'

/** The value Launch writes: its App id as GitHub shows it (a plain decimal integer). */
export function gateAppIdValue(appId: string | number): string {
  const value = String(appId).trim()
  if (!/^\d+$/.test(value)) throw new Error(`The GitHub App id is not numeric (${value})`)
  return value
}

/** Set the variable to Launch's App id unless it already holds it. Needs `actions_variables: write`. */
export async function ensureGateVariable(
  token: string,
  owner: string,
  repo: string,
  appId: string | number,
  opts: GitHubOptions = {}
): Promise<GateVariableWrite> {
  const expected = gateAppIdValue(appId)
  const current = await getRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, opts)
  if (current?.trim() === expected) return 'unchanged'
  await upsertRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, expected, opts)
  return current === null ? 'created' : 'updated'
}

/** What the repo holds against Launch's App id. Needs `actions_variables: read`; never throws. */
export async function diagnoseGateVariable(
  token: string,
  owner: string,
  repo: string,
  appId: string | number,
  opts: GitHubOptions = {}
): Promise<AppGateVariable> {
  let expected: string
  try {
    expected = gateAppIdValue(appId)
  } catch (err) {
    return { state: 'unknown', value: null, expected: null, detail: (err as Error).message }
  }
  let value: string | null
  try {
    value = await getRepoVariable(token, owner, repo, LAUNCH_GATE_APP_ID_VARIABLE, opts)
  } catch (err) {
    return {
      state: 'unknown',
      value: null,
      expected,
      detail: `GitHub could not read the ${LAUNCH_GATE_APP_ID_VARIABLE} variable: ${(err as Error).message}`,
    }
  }
  if (value === null) {
    return {
      state: 'missing',
      value: null,
      expected,
      detail: `${owner}/${repo} has no ${LAUNCH_GATE_APP_ID_VARIABLE} variable, so CI runs the full gate again on a change Launch already gated. Apply sets it.`,
    }
  }
  if (value.trim() !== expected) {
    return {
      state: 'wrong',
      value,
      expected,
      detail: `${owner}/${repo}'s ${LAUNCH_GATE_APP_ID_VARIABLE} is ${value}, not Launch's GitHub App (${expected}), so CI does not trust Launch's gate. Apply sets it.`,
    }
  }
  return { state: 'ok', value, expected, detail: null }
}

/**
 * Set the variable on `app`'s repo with a token narrowed to it — the start of a kit upgrade.
 * Throws whatever GitHub or the token mint refused; callers that must not fail catch it.
 */
export async function ensureAppGateVariable(
  db: Database,
  cfg: AppConfig,
  app: Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>,
  opts: RepoGitHubOptions = {}
): Promise<GateVariableWrite> {
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  return withRepoToken(
    db,
    cfg,
    app,
    GITHUB_TOKEN_PERMISSIONS.gateVariableWrite,
    (token, repo) => ensureGateVariable(token, repo.owner, repo.repo, github.auth.appId, opts),
    { ...opts, github }
  )
}
