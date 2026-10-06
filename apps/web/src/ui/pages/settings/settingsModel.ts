/**
 * What Settings offers, as plain data: the groups of its menu, each section's path and guard, and
 * the sub-tabs inside People and AI & models. `SettingsLayout` maps a section id to its page; the
 * decision of who sees what is made HERE, by `visibleSettingsGroups`, with the same `useNavGuard`
 * function the routes use — so the menu can never list a page its reader would bounce off. Pure,
 * and tested in `tests/config/settings-model.test.ts`.
 *
 * Every guard is the one the section's page carried before Settings was one place: `admin` for
 * the organisation's own settings (the old `/settings` route), `platformAdmin` for the deployment
 * (the old `/settings/platform/*`), `globalAdmin` for the operator's (the old `/admin/*`), and the
 * narrower ability the old tab checked on top (`manage Group`, `manage ApprovalPolicy`,
 * `manage AiConfig`).
 */
import type { SetupStepId } from '@launch/shared/launch-setup'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import {
  CONNECTION_LABELS,
  CONNECTION_ORDER,
  CONNECTION_PATHS,
  pluginSettingsPath,
  SETTINGS_PATHS,
} from '@/ui/lib/settings-paths'

export type SettingsSectionId =
  | 'general'
  | 'people'
  | 'approval-policies'
  | 'api-keys'
  | 'coding-agents'
  | 'ai'
  | 'prompts'
  | 'kit'
  | `connection:${SetupStepId}`
  | 'audit'
  | 'usage'
  | 'users'
  | 'feature-flags'
  | 'sessions'
  | 'organisations'
  | `plugin:${string}`

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  /** Absolute path; the section owns it and everything under it. */
  path: string
  guard: NavGuard
  /** A Connections page: its setup step, whose status dot the menu shows. */
  step?: SetupStepId
  /** People: the pending access-request count rides on it. */
  badge?: 'accessRequests'
}

export interface SettingsGroup {
  label: string
  sections: SettingsSection[]
}

/** A tab inside a section (People, AI & models) — a real path too, guarded like a section. */
export interface SettingsSubTab {
  label: string
  path: string
  guard: NavGuard
  badge?: 'accessRequests'
}

const ADMIN: NavGuard = 'admin'
const PLATFORM: NavGuard = 'platformAdmin'
const OPERATOR: NavGuard = 'globalAdmin'
const MANAGE_GROUPS: NavGuard = ['admin', { action: 'manage', subject: 'Group' }]
const MANAGE_AI: NavGuard = ['admin', { action: 'manage', subject: 'AiConfig' }]

export const PEOPLE_TABS: readonly SettingsSubTab[] = [
  { label: 'Members', path: SETTINGS_PATHS.people, guard: ADMIN },
  { label: 'Groups', path: SETTINGS_PATHS.groups, guard: MANAGE_GROUPS },
  {
    label: 'Access requests',
    path: SETTINGS_PATHS.accessRequests,
    guard: PLATFORM,
    badge: 'accessRequests',
  },
]

export const AI_TABS: readonly SettingsSubTab[] = [
  { label: 'Providers', path: SETTINGS_PATHS.ai, guard: ADMIN },
  { label: 'Agent models', path: SETTINGS_PATHS.agentModels, guard: MANAGE_AI },
]

/** A plugin's settings tab (D31) as the menu needs it: the plugin already decided who sees it. */
export interface PluginSettingsTab {
  id: string
  label: string
}

export function settingsGroups({
  single,
  pluginTabs = [],
}: {
  single: boolean
  pluginTabs?: readonly PluginSettingsTab[]
}): SettingsGroup[] {
  return [
    {
      label: 'Organisation',
      sections: [
        { id: 'general', label: 'General', path: SETTINGS_PATHS.general, guard: ADMIN },
        {
          id: 'people',
          label: 'People',
          path: SETTINGS_PATHS.people,
          // Members for an organisation admin, access requests for a platform admin — which in
          // multi mode includes a global admin who belongs to no organisation.
          guard: { anyOf: PEOPLE_TABS.map(tab => tab.guard) },
          badge: 'accessRequests',
        },
        {
          id: 'approval-policies',
          label: 'Approval policies',
          path: SETTINGS_PATHS.approvalPolicies,
          guard: ['admin', { action: 'manage', subject: 'ApprovalPolicy' }],
        },
        { id: 'api-keys', label: 'API keys', path: SETTINGS_PATHS.apiKeys, guard: ADMIN },
      ],
    },
    {
      label: 'Building apps',
      sections: [
        {
          id: 'coding-agents',
          label: 'Coding agents',
          path: SETTINGS_PATHS.codingAgents,
          guard: PLATFORM,
        },
        { id: 'ai', label: 'AI & models', path: SETTINGS_PATHS.ai, guard: ADMIN },
        { id: 'prompts', label: 'Prompts', path: SETTINGS_PATHS.prompts, guard: ADMIN },
        { id: 'kit', label: 'Kit version', path: SETTINGS_PATHS.kit, guard: PLATFORM },
      ],
    },
    {
      label: 'Connections',
      sections: CONNECTION_ORDER.map(step => ({
        id: `connection:${step}` as const,
        label: CONNECTION_LABELS[step],
        path: CONNECTION_PATHS[step],
        guard: PLATFORM,
        step,
      })),
    },
    {
      label: 'Activity',
      sections: [
        { id: 'audit', label: 'Audit', path: SETTINGS_PATHS.audit, guard: ADMIN },
        { id: 'usage', label: 'Usage', path: SETTINGS_PATHS.usage, guard: MANAGE_AI },
      ],
    },
    {
      label: 'Operator',
      sections: [
        { id: 'users', label: 'Users', path: SETTINGS_PATHS.users, guard: OPERATOR },
        {
          id: 'feature-flags',
          label: 'Feature flags',
          path: SETTINGS_PATHS.featureFlags,
          guard: OPERATOR,
        },
        { id: 'sessions', label: 'All sessions', path: SETTINGS_PATHS.sessions, guard: OPERATOR },
        // One organisation has nothing to list: its settings are the Organisation group above.
        ...(single
          ? []
          : [
              {
                id: 'organisations' as const,
                label: 'Organisations',
                path: SETTINGS_PATHS.organisations,
                guard: OPERATOR,
              },
            ]),
      ],
    },
    {
      label: 'Plugins',
      sections: pluginTabs.map(tab => ({
        id: `plugin:${tab.id}` as const,
        label: tab.label,
        path: pluginSettingsPath(tab.id),
        // Plugin tabs lived on the organisation's `/settings`, behind `admin`; each plugin then
        // decided for itself through `ctx.can`, before the tab reached this list.
        guard: ADMIN,
      })),
    },
  ]
}

/** Apply the guard to every section and drop a group it empties. Pure. */
export function visibleSettingsGroups(
  groups: readonly SettingsGroup[],
  canAccess: (guard: NavGuard | undefined) => boolean
): SettingsGroup[] {
  return groups
    .map(group => ({ ...group, sections: group.sections.filter(s => canAccess(s.guard)) }))
    .filter(group => group.sections.length > 0)
}

/** Where `/settings` itself lands: the reader's first section, or `null` with none. Pure. */
export function firstSettingsPath(groups: readonly SettingsGroup[]): string | null {
  return groups[0]?.sections[0]?.path ?? null
}
