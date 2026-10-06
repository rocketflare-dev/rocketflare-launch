/**
 * A setup overview (`GET /api/platform/setup`) for UI tests: a mix of every step status, one set
 * credential with its probes, and the coding-agent and sandbox sections. Shared by the Settings
 * pages' tests and Home's setup checklist.
 */
import {
  DEFAULT_TEMPLATE_PIN,
  type SetupCredential,
  type SetupOverview,
} from '@launch/shared/launch-setup'

export const unsetCredential = (kind: SetupCredential['kind']): SetupCredential => ({
  kind,
  set: false,
  setAt: null,
  setByUserId: null,
  setByEmail: null,
  rotatedAt: null,
  metadata: {},
  lastCheckStatus: null,
  lastCheck: null,
  lastCheckedAt: null,
})

export const setupOverview: SetupOverview = {
  steps: [
    { id: 'domain', status: 'ok' },
    { id: 'cloudflare', status: 'warning' },
    { id: 'neon', status: 'todo' },
    { id: 'resend', status: 'failed' },
    { id: 'github', status: 'todo' },
    { id: 'identity', status: 'ok' },
    { id: 'public_url', status: 'failed' },
  ],
  settings: {
    apps_domain: 'company-apps.test',
    cloudflare_account_id: '0123456789abcdef0123456789abcdef',
    neon_org_id: null,
    neon_region_id: null,
    notifications_domain: null,
    github_org: null,
  },
  effectiveNotificationsDomain: 'notifications.company-apps.test',
  credentials: [
    {
      ...unsetCredential('cloudflare_api_token'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      setByUserId: '11111111-1111-4111-8111-111111111111',
      setByEmail: 'ada@example.test',
      metadata: { accountId: '0123456789abcdef0123456789abcdef' },
      lastCheckStatus: 'warning',
      lastCheck: [
        { id: 'zone.account', label: 'Apps zone in this account', status: 'ok' },
        {
          id: 'token.write',
          label: 'Write permissions',
          status: 'warning',
          detail: 'Write scope unverified',
        },
      ],
      lastCheckedAt: new Date('2026-09-01T00:00:00Z'),
    },
    unsetCredential('neon_org_api_key'),
    {
      ...unsetCredential('resend_api_key'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckStatus: 'failed',
      lastCheck: [
        {
          id: 'domain.verified',
          label: 'Notifications domain verified',
          status: 'failed',
          detail: 'notifications.company-apps.test is not a Resend domain yet.',
        },
      ],
    },
    unsetCredential('github_app'),
  ],
  identity: {
    providers: ['google'],
    oidc: null,
    oidcOnly: false,
    checks: [{ id: 'providers', label: 'Single sign-on configured', status: 'ok' }],
  },
  publicUrl: {
    url: 'http://localhost:3000',
    status: 'failed',
    checks: [
      {
        id: 'url',
        label: 'Public URL',
        status: 'failed',
        detail: 'http://localhost:3000 is only reachable from this machine or network',
      },
    ],
    checkedAt: null,
  },
  templatePin: {
    pin: DEFAULT_TEMPLATE_PIN,
    isDefault: true,
    default: DEFAULT_TEMPLATE_PIN,
    latestCheck: null,
  },
  sessionAgents: {
    runtimes: [
      {
        runtime: 'claude_code',
        label: 'Claude Code',
        accountLabel: 'Claude subscription',
        enabled: true,
        model: 'claude-sonnet-4-5',
        credentialMode: 'platform',
        isDefault: true,
        models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
        platformKey: { kind: 'anthropic_api_key', source: 'secret' },
        connectedAccounts: 0,
        minImage: null,
      },
      {
        runtime: 'codex',
        label: 'Codex',
        accountLabel: 'ChatGPT plan',
        enabled: false,
        model: 'gpt-6.1-sol',
        credentialMode: 'platform',
        isDefault: true,
        models: ['gpt-6.1-sol'],
        platformKey: { kind: 'openai_api_key', source: null },
        connectedAccounts: 2,
        minImage: 'session-6',
      },
    ],
  },
  sessionSandbox: {
    host: 'local',
    isDefault: true,
    options: [
      { host: 'local', label: "This Worker's containers", available: true, reason: null },
      {
        host: 'remote',
        label: 'Remote sandbox host',
        available: false,
        reason: 'pnpm dev could not use your Cloudflare account. Run wrangler login.',
      },
    ],
  },
}

/** The same overview with every connection working. */
export const setupComplete: SetupOverview = {
  ...setupOverview,
  steps: setupOverview.steps.map(step => ({
    ...step,
    status: step.id === 'identity' ? 'warning' : 'ok',
  })),
}
