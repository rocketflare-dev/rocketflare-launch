/**
 * GitHub Actions OIDC for tests (Launch P2, `/ci/*`): one RSA key standing in for GitHub's, its
 * JWKS served at GitHub's own URL, and `mintActionsToken(claims)` — a token exactly as a job's
 * `ACTIONS_ID_TOKEN_REQUEST_URL` would hand it out, signed with that key.
 *
 * ```ts
 * const token = await mintActionsToken(actionsClaims({ repository: 'acme/shop', repositoryId: '42',
 *   environment: 'staging', workflowFile: 'deploy.yml' }))
 * await request('/ci/deploy/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, … })
 * ```
 *
 * The route needs the JWKS: pass `fetch: cloud.fetch` (a FakeCloud serves it) or
 * `actionsJwksFetch()` to `verifyGitHubOidc`, or install a FakeCloud as the global `fetch`.
 * `{ forged: true }` signs with a key NOT in the JWKS (a same-`kid` impostor); `expiresInSeconds`
 * below zero mints an expired one.
 */
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import {
  GITHUB_ACTIONS_ISSUER,
  GITHUB_ACTIONS_JWKS_URL,
  type GitHubOidcClaims,
} from '@/api/services/launch/ci/github-oidc'
import { jsonResponse } from './vendor-fetch'

export const ACTIONS_ISSUER = GITHUB_ACTIONS_ISSUER
export const ACTIONS_JWKS_URL = GITHUB_ACTIONS_JWKS_URL
/** `createTestEnv()`'s `APP_URL` — the audience `/ci` answers to unless a test overrides it. */
export const DEFAULT_ACTIONS_AUDIENCE = 'http://localhost:3001'
const KID = 'launch-test-actions-key'

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>
let keys: Promise<{ real: KeyPair; forged: KeyPair; jwk: JWK }> | null = null

function actionsKeys() {
  keys ??= (async () => {
    const real = await generateKeyPair('RS256', { extractable: true })
    const forged = await generateKeyPair('RS256', { extractable: true })
    const jwk = { ...(await exportJWK(real.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
    return { real, forged, jwk }
  })()
  return keys
}

/** GitHub's JWKS document, as `https://token.actions.githubusercontent.com/.well-known/jwks` serves it. */
export async function actionsJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await actionsKeys()).jwk] }
}

/** A `fetch` that serves ONLY the Actions JWKS (anything else is a 599). */
export function actionsJwksFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === ACTIONS_JWKS_URL) return jsonResponse(await actionsJwks())
    return jsonResponse({ message: `no fake for ${url}` }, 599)
  }) as typeof fetch
}

export interface ActionsClaimsInput {
  /** `owner/name`. */
  repository: string
  /** GitHub's numeric repository id, as a string (`apps.github_repo_id`). */
  repositoryId: string
  environment?: string
  /** The file the job is defined in: `job_workflow_ref` = `<repo>/.github/workflows/<file>@<ref>`. */
  workflowFile?: string
  ref?: string
  runId?: string
  runAttempt?: string
  sha?: string
  actor?: string
  /** Anything else to set or override (e.g. a different `job_workflow_ref`). */
  extra?: Partial<GitHubOidcClaims>
}

/** A full, plausible claim set for a job in `repository` (deploy.yml on `main` by default). */
export function actionsClaims(input: ActionsClaimsInput): Partial<GitHubOidcClaims> {
  const ref = input.ref ?? 'refs/heads/main'
  const workflowFile = input.workflowFile ?? 'deploy.yml'
  const [owner] = input.repository.split('/')
  const jobWorkflowRef = `${input.repository}/.github/workflows/${workflowFile}@${ref}`
  return {
    sub: input.environment
      ? `repo:${input.repository}:environment:${input.environment}`
      : `repo:${input.repository}:ref:${ref}`,
    repository: input.repository,
    repository_id: input.repositoryId,
    repository_owner: owner,
    repository_owner_id: '1001',
    ...(input.environment ? { environment: input.environment } : {}),
    ref,
    ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    sha: input.sha ?? 'a'.repeat(40),
    run_id: input.runId ?? String(9_000_000 + Math.floor(Math.random() * 1_000_000)),
    run_attempt: input.runAttempt ?? '1',
    run_number: '1',
    actor: input.actor ?? 'octocat',
    actor_id: '1',
    event_name: 'workflow_dispatch',
    job_workflow_ref: jobWorkflowRef,
    workflow_ref: jobWorkflowRef,
    ...input.extra,
  }
}

export interface MintActionsTokenOptions {
  /** Default `DEFAULT_ACTIONS_AUDIENCE`. */
  audience?: string
  issuer?: string
  /** Default 300 (GitHub's tokens live five minutes). Negative = already expired. */
  expiresInSeconds?: number
  /** Sign with a key that is NOT in the JWKS, under the same `kid`. */
  forged?: boolean
}

/** A signed GitHub Actions OIDC token carrying `claims`. */
export async function mintActionsToken(
  claims: Partial<GitHubOidcClaims>,
  opts: MintActionsTokenOptions = {}
): Promise<string> {
  const { real, forged } = await actionsKeys()
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = opts.expiresInSeconds ?? 300
  const { iss: _iss, aud: _aud, exp: _exp, iat: _iat, nbf: _nbf, ...rest } = claims
  return new SignJWT(rest)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(opts.issuer ?? ACTIONS_ISSUER)
    .setAudience(opts.audience ?? DEFAULT_ACTIONS_AUDIENCE)
    .setIssuedAt(now - 10 + Math.min(0, expiresIn))
    .setNotBefore(now - 10 + Math.min(0, expiresIn))
    .setExpirationTime(now + expiresIn)
    .sign(opts.forged ? forged.privateKey : real.privateKey)
}
