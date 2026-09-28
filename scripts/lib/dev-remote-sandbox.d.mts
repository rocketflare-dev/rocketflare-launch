/**
 * Hand-written types for `dev-remote-sandbox.mjs` (the workspace has no `allowJs`). Keep in step
 * with the exports there.
 */
export const REMOTE_DEV_CONFIG: 'wrangler.dev-remote.toml'
export const SANDBOX_HOST_SERVICE: 'launch-sandbox-dev'
export function remoteSandboxEnabled(devVars?: Record<string, string | undefined>): boolean
export function remoteDevConfigText(baseToml: string): string
export function remoteDevWranglerArgs(): string[]
