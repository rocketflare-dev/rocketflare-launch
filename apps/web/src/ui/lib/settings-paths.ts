/**
 * Where everything under Settings lives. One module so a link from anywhere — the nav, Home's setup
 * checklist, the Create-app modal's public-URL hint, the redirects from every old address — never
 * imports a lazy page to learn a path. Plain data: the eager shell reads it.
 *
 * Settings is ONE layout (`pages/settings/SettingsLayout.tsx`) with a grouped menu on the left and
 * a real path per section. It replaced three areas that each had their own nav item: the tabbed
 * `/settings?tab=` page, `/settings/platform/*` (Setup, Kit, Coding agents, Identity, Access
 * requests) and the operator's `/admin/*`; every one of their addresses redirects here.
 */
import type { SetupStepId } from '@launch/shared/launch-setup'
import type { NavGuard } from '@/ui/hooks/useNavGuard'

export const SETTINGS_PATH = '/settings'

/** Every section's path, by id. A section's id IS its path segment. */
export const SETTINGS_PATHS = {
  // Organisation
  general: `${SETTINGS_PATH}/general`,
  people: `${SETTINGS_PATH}/people`,
  groups: `${SETTINGS_PATH}/people/groups`,
  accessRequests: `${SETTINGS_PATH}/people/access-requests`,
  approvalPolicies: `${SETTINGS_PATH}/approval-policies`,
  apiKeys: `${SETTINGS_PATH}/api-keys`,
  // Building apps
  codingAgents: `${SETTINGS_PATH}/coding-agents`,
  ai: `${SETTINGS_PATH}/ai`,
  agentModels: `${SETTINGS_PATH}/ai/agent-models`,
  prompts: `${SETTINGS_PATH}/prompts`,
  kit: `${SETTINGS_PATH}/kit`,
  // Connections — one per setup step
  domain: `${SETTINGS_PATH}/domain`,
  cloudflare: `${SETTINGS_PATH}/cloudflare`,
  neon: `${SETTINGS_PATH}/neon`,
  github: `${SETTINGS_PATH}/github`,
  email: `${SETTINGS_PATH}/email`,
  signIn: `${SETTINGS_PATH}/sign-in`,
  publicUrl: `${SETTINGS_PATH}/public-url`,
  // Activity
  audit: `${SETTINGS_PATH}/audit`,
  usage: `${SETTINGS_PATH}/usage`,
  // Operator (global admins)
  users: `${SETTINGS_PATH}/users`,
  featureFlags: `${SETTINGS_PATH}/feature-flags`,
  sessions: `${SETTINGS_PATH}/sessions`,
  organisations: `${SETTINGS_PATH}/organisations`,
} as const

export const userPath = (id: string) => `${SETTINGS_PATHS.users}/${encodeURIComponent(id)}`
export const organisationPath = (id: string) =>
  `${SETTINGS_PATHS.organisations}/${encodeURIComponent(id)}`
/** A plugin's settings tab (D31), namespaced so its id can never shadow a kit section. */
export const pluginSettingsPath = (tabId: string) =>
  `${SETTINGS_PATH}/plugins/${encodeURIComponent(tabId)}`

/**
 * Who sees the Settings nav item and may open `/settings` at all: anyone with at least one section.
 * Every section is guarded by `admin` or `platformAdmin` (or something narrower), and in multi mode
 * neither covers the other — an organisation's owner is not a platform admin, and a global admin
 * with no membership is not an organisation admin.
 */
export const SETTINGS_GUARD: NavGuard = { anyOf: ['admin', 'platformAdmin'] }

/** Each setup step's Connections page, in the order the menu (and Home's checklist) lists them. */
export const CONNECTION_PATHS: Record<SetupStepId, string> = {
  domain: SETTINGS_PATHS.domain,
  cloudflare: SETTINGS_PATHS.cloudflare,
  neon: SETTINGS_PATHS.neon,
  github: SETTINGS_PATHS.github,
  resend: SETTINGS_PATHS.email,
  identity: SETTINGS_PATHS.signIn,
  public_url: SETTINGS_PATHS.publicUrl,
}

/** What the menu and Home call each connection. */
export const CONNECTION_LABELS: Record<SetupStepId, string> = {
  domain: 'Domain',
  cloudflare: 'Cloudflare',
  neon: 'Neon',
  github: 'GitHub',
  resend: 'Email',
  identity: 'Sign-in',
  public_url: 'Public URL',
}

export const CONNECTION_ORDER: readonly SetupStepId[] = [
  'domain',
  'cloudflare',
  'neon',
  'github',
  'resend',
  'identity',
  'public_url',
]

/** The old `/settings?tab=` ids. A plugin's tab id falls through to `pluginSettingsPath`. */
const LEGACY_TABS: Record<string, string> = {
  general: SETTINGS_PATHS.general,
  people: SETTINGS_PATHS.people,
  groups: SETTINGS_PATHS.groups,
  'api-keys': SETTINGS_PATHS.apiKeys,
  approvals: SETTINGS_PATHS.approvalPolicies,
  ai: SETTINGS_PATHS.ai,
  prompts: SETTINGS_PATHS.prompts,
  'agent-models': SETTINGS_PATHS.agentModels,
  usage: SETTINGS_PATHS.usage,
}

/** Where an old `/settings?tab=<id>` link goes now; `null` for no tab. Pure. */
export function legacyTabPath(
  tab: string | null,
  pluginTabIds: readonly string[] = []
): string | null {
  if (!tab) return null
  if (Object.hasOwn(LEGACY_TABS, tab)) return LEGACY_TABS[tab]
  if (pluginTabIds.includes(tab)) return pluginSettingsPath(tab)
  return null
}

/**
 * Where the old setup wizard (`/settings/platform/setup`, `/admin/setup`) goes now: a step anchor
 * (`#setup-public_url`, what the Create-app modal used to link) opens that step's own page, and
 * anything else the first connection. Pure.
 */
export function legacySetupPath(hash: string): string {
  const id = hash.replace(/^#setup-/, '')
  return Object.hasOwn(CONNECTION_PATHS, id)
    ? CONNECTION_PATHS[id as SetupStepId]
    : SETTINGS_PATHS.domain
}
