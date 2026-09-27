/**
 * Verifying a GitHub Actions OIDC token (Launch P2, `/ci/*`) — the ONLY credential a CI job brings.
 * The token is a JWT GitHub signs with the keys at `GITHUB_ACTIONS_JWKS_URL`; the job mints a
 * fresh one per call with the audience Launch told it (`DEPLOYER_AUDIENCE` = `APP_URL`).
 *
 * What this proves: GitHub issued it, for this audience, and it has not expired. What it does NOT
 * prove is that Launch should listen to it — that is `resolveCaller` (`caller.ts`), which maps the
 * repository, environment, workflow file and ref to an app. Any failure here is one 401
 * (`github_oidc_invalid`) with a coarse `details.reason` (`expired`, `claim aud`, `signature`) — the
 * job's log needs to say which, and none of them tells a forger anything a JWT library would not.
 *
 * `fetch` is injectable (jose 6 `customFetch`), so tests serve their own JWKS
 * (`tests/helpers/github-oidc.ts`) and nothing reaches GitHub. The key set is cached per `fetch`
 * for the isolate's life — jose refetches on an unknown `kid`, which is how a GitHub key rotation
 * is picked up.
 */
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose'
import { UnauthorizedError } from '../../../utils/core/errors'

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com'
export const GITHUB_ACTIONS_JWKS_URL = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`

/**
 * The claims Launch reads (docs.github.com → "About security hardening with OpenID Connect").
 * GitHub sends ids as STRINGS (`repository_id: "123"`, `run_id: "456"`).
 */
export interface GitHubOidcClaims extends JWTPayload {
  iss: string
  sub: string
  repository: string
  repository_id: string
  repository_owner: string
  repository_owner_id?: string
  /** Present only when the job targets an environment. */
  environment?: string
  ref: string
  ref_type?: string
  sha: string
  run_id: string
  run_attempt: string
  run_number?: string
  actor: string
  actor_id?: string
  event_name?: string
  /** `<owner>/<repo>/.github/workflows/<file>@<ref>` — the workflow the JOB is defined in. */
  job_workflow_ref: string
  workflow_ref?: string
}

export interface VerifyGitHubOidcOptions {
  /** The `aud` Launch answers to — `APP_URL`. */
  audience: string
  fetch?: typeof fetch
  /** Override the JWKS location (tests); defaults to GitHub's. */
  jwksUrl?: string
  /** Seconds since the epoch, for `exp`/`nbf` (tests). */
  currentDate?: Date
}

const REQUIRED_CLAIMS = [
  'repository',
  'repository_id',
  'ref',
  'sha',
  'run_id',
  'run_attempt',
  'actor',
  'job_workflow_ref',
] as const

const keySets = new WeakMap<typeof fetch, Map<string, ReturnType<typeof createRemoteJWKSet>>>()

function keySetFor(url: string, doFetch: typeof fetch) {
  let byUrl = keySets.get(doFetch)
  if (!byUrl) {
    byUrl = new Map()
    keySets.set(doFetch, byUrl)
  }
  let keys = byUrl.get(url)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), {
      [customFetch]: (input, init) => doFetch(input, init),
    })
    byUrl.set(url, keys)
  }
  return keys
}

/** The bearer token of a `/ci` request, or a 401. */
export function bearerToken(header: string | null | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!match)
    throw new UnauthorizedError('A GitHub Actions OIDC token is required', 'github_oidc_missing')
  return match[1]
}

/**
 * Verify `token` and return its claims, or throw a 401. RS256 only, GitHub's issuer, exactly
 * `audience`, not expired, and every claim `resolveCaller` needs present as a string.
 */
export async function verifyGitHubOidc(
  token: string,
  opts: VerifyGitHubOidcOptions
): Promise<GitHubOidcClaims> {
  const keys = keySetFor(opts.jwksUrl ?? GITHUB_ACTIONS_JWKS_URL, opts.fetch ?? fetch)
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_ACTIONS_ISSUER,
      audience: opts.audience,
      algorithms: ['RS256'],
      ...(opts.currentDate ? { currentDate: opts.currentDate } : {}),
    }))
  } catch (err) {
    const reason =
      err instanceof joseErrors.JWTExpired
        ? 'expired'
        : err instanceof joseErrors.JWTClaimValidationFailed
          ? `claim ${err.claim}`
          : 'signature'
    throw new UnauthorizedError(
      'The GitHub Actions OIDC token is not valid',
      'github_oidc_invalid',
      {
        reason,
      }
    )
  }
  for (const claim of REQUIRED_CLAIMS) {
    if (typeof payload[claim] !== 'string' || payload[claim] === '') {
      throw new UnauthorizedError(
        'The GitHub Actions OIDC token is not valid',
        'github_oidc_invalid',
        {
          reason: `claim ${claim}`,
        }
      )
    }
  }
  return payload as GitHubOidcClaims
}
