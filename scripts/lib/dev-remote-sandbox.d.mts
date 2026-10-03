/**
 * Hand-written types for `dev-remote-sandbox.mjs` (the workspace has no `allowJs`). Keep in step
 * with the exports there.
 */
export type SandboxHostStatus = 'ok' | 'not_logged_in' | 'not_deployed' | 'off'
export const REMOTE_DEV_CONFIG: 'wrangler.dev-remote.toml'
export const SANDBOX_HOST_SERVICE: 'launch-sandbox-dev'
export const SANDBOX_HOST_STATUSES: SandboxHostStatus[]
export function legacyRemoteRequested(devVars?: Record<string, string | undefined>): boolean
export function remoteDevConfigText(baseToml: string): string
export function devSandboxPlan(found: { docker: boolean; remote: SandboxHostStatus | string }): {
  args: string[]
  writeRemoteConfig: boolean
  lines: string[]
  status: SandboxHostStatus
}
export function whoamiLoggedIn(output: string | null | undefined): boolean
