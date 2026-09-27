/**
 * The issuer's identity and its published metadata (spec/05, OIDC Discovery 1.0). Pure: no
 * database, no keys — `keys.ts` publishes the JWKS, `tokens.ts` signs.
 *
 * **The issuer is `APP_URL` with no trailing slash** (plan decision 5). Every relying party
 * compares the `iss` it is handed to the one it was configured with byte for byte, so this one
 * function is the only place the string is built. Launch's own `OIDC_ISSUER` is its UPSTREAM
 * login and can never equal it (`loadConfig` refuses the pair).
 *
 * The lifetimes live here because three modules must agree on them: the token endpoint issues with
 * them, the code store keeps rows past them (replay revocation), and key rotation keeps a retiring
 * key published until the longest of them has passed.
 */
import type { AppConfig } from '../../../config'

/** An authorization code lives 60 s: the redirect back to the app is immediate. */
export const CODE_TTL_S = 60
/** The id_token is consumed once, at sign-in, by the app. */
export const ID_TOKEN_TTL_S = 300
/** The access token only reaches `/oidc/userinfo`. */
export const ACCESS_TOKEN_TTL_S = 600
/** The longest-lived thing this issuer signs. */
export const MAX_TOKEN_TTL_S = Math.max(ID_TOKEN_TTL_S, ACCESS_TOKEN_TTL_S)
/**
 * Beyond the longest token, how long a rotated-out key stays in the JWKS: a relying party caches
 * the key set (the kit's for up to an hour), and a token it holds must still verify against it.
 */
export const KEY_RETIRE_MARGIN_S = 60 * 60
/** Codes are pruned only this long after they expire, so a late replay still finds its row. */
export const CODE_RETENTION_S = MAX_TOKEN_TTL_S + 60 * 60

export const SIGNING_ALG = 'ES256'

export const SUPPORTED_SCOPES = ['openid', 'email', 'profile', 'groups'] as const

/** `APP_URL` without a trailing slash — THE issuer identifier. */
export function issuerOf(cfg: Pick<AppConfig, 'APP_URL'>): string {
  return cfg.APP_URL.replace(/\/+$/, '')
}

export interface IssuerEndpoints {
  issuer: string
  authorization: string
  token: string
  userinfo: string
  jwks: string
  endSession: string
  discovery: string
}

export function endpointsOf(cfg: Pick<AppConfig, 'APP_URL'>): IssuerEndpoints {
  const iss = issuerOf(cfg)
  return {
    issuer: iss,
    authorization: `${iss}/oidc/authorize`,
    token: `${iss}/oidc/token`,
    userinfo: `${iss}/oidc/userinfo`,
    jwks: `${iss}/.well-known/jwks.json`,
    endSession: `${iss}/oidc/logout`,
    discovery: `${iss}/.well-known/openid-configuration`,
  }
}

/** The access token's audience: the only resource it opens is userinfo. */
export function accessTokenAudience(cfg: Pick<AppConfig, 'APP_URL'>): string {
  return endpointsOf(cfg).userinfo
}

/** `/.well-known/openid-configuration` — the spec/05 subset and nothing it does not do. */
export function discoveryDocument(cfg: Pick<AppConfig, 'APP_URL'>) {
  const e = endpointsOf(cfg)
  return {
    issuer: e.issuer,
    authorization_endpoint: e.authorization,
    token_endpoint: e.token,
    userinfo_endpoint: e.userinfo,
    jwks_uri: e.jwks,
    end_session_endpoint: e.endSession,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [SIGNING_ALG],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...SUPPORTED_SCOPES],
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'email',
      'email_verified',
      'name',
      'groups',
    ],
    // RFC 9207: `iss` rides on every authorization response, so a client can detect a mix-up.
    authorization_response_iss_parameter_supported: true,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  }
}
