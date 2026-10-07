/**
 * `/settings/*`: every setting in Launch, in one place — a grouped menu on the left, one section
 * at a time on the right, each at a real path (`lib/settings-paths.ts`) so links, bookmarks and the
 * back button work. The groups are Organisation · Building apps · Platform · Activity · Operator
 * (global admins) · Plugins (D31); WHAT each offers and who sees it is the pure `settingsModel.ts`.
 *
 * It replaced three areas — the tabbed `/settings?tab=`, the deployment's `/settings/platform/*`
 * and the operator's `/admin/*` — and kept each section's guard exactly: the route is behind
 * `SETTINGS_GUARD` (`admin` OR `platformAdmin`, `App.tsx`), each section behind its own
 * `RequireGuard`, and the menu lists exactly the sections those guards let through, dropping a
 * group they empty. A global admin with no membership may open this layout (`ProtectedRoute`'s
 * `isAdminPath`); `useNavGuard` then passes only their `platformAdmin` / `globalAdmin` sections.
 *
 * Platform pages carry their setup status as a dot in the menu (the same `useSetupOverview` the pages
 * read), and People the count of access requests waiting. Below `lg` the menu collapses into one
 * `<select>` of the same groups, so a phone keeps the whole page width for the section.
 */

import type { SetupStepStatus } from '@launch/shared/launch-setup'
import type { Actions, Subjects } from '@launch/shared/permissions'
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { uiPlugins } from '@/plugins/ui'
import { RequireGuard } from '@/ui/components/RequireGuard'
import { PageHeader, type TabConfig } from '@/ui/components/shared'
import { useAdminAccessRequests } from '@/ui/hooks/useAdminAccessRequests'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { legacyTabPath, SETTINGS_PATH, SETTINGS_PATHS } from '@/ui/lib/settings-paths'
import Audit from '@/ui/pages/Audit'
import FeatureFlags from '@/ui/pages/admin/FeatureFlags'
import SessionsAdmin from '@/ui/pages/admin/SessionsAdmin'
import TenantDetail from '@/ui/pages/admin/TenantDetail'
import TenantList from '@/ui/pages/admin/TenantList'
import UserDetail from '@/ui/pages/admin/UserDetail'
import UserList from '@/ui/pages/admin/UserList'
import AccessRequests from '@/ui/pages/platform/AccessRequests'
import CodingAgents from '@/ui/pages/platform/CodingAgents'
import Connection from '@/ui/pages/platform/Connection'
import Kit from '@/ui/pages/platform/Kit'
import { StatusDot } from '@/ui/pages/platform/setup/StatusDot'
import AgentModelsSettings from './AgentModels'
import AiSettings from './AI'
import ApiKeys from './ApiKeys'
import ApprovalPoliciesSettings from './ApprovalPolicies'
import General from './General'
import GroupsSettings from './Groups'
import People from './People'
import PromptsSettings from './Prompts'
import {
  AI_TABS,
  firstSettingsPath,
  PEOPLE_TABS,
  type SettingsGroup,
  type SettingsSection,
  type SettingsSubTab,
  settingsGroups,
  visibleSettingsGroups,
} from './settingsModel'
import UsageSettings from './Usage'

/** The live numbers and dots beside menu entries, fetched once by the layout. */
interface MenuState {
  stepStatus: (step: NonNullable<SettingsSection['step']>) => SetupStepStatus | undefined
  pendingRequests: number
}

/** The section whose path is the longest prefix of where the reader is. Pure. */
export function activeSection(
  groups: readonly SettingsGroup[],
  pathname: string
): SettingsSection | undefined {
  return groups
    .flatMap(group => group.sections)
    .filter(s => pathname === s.path || pathname.startsWith(`${s.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

function MenuAdornment({ section, state }: { section: SettingsSection; state: MenuState }) {
  if (section.step) {
    const status = state.stepStatus(section.step)
    return status ? <StatusDot status={status} /> : null
  }
  if (section.badge === 'accessRequests' && state.pendingRequests > 0) {
    return (
      <span className="badge badge-sm badge-warning tabular-nums">
        {state.pendingRequests}
        <span className="sr-only"> waiting</span>
      </span>
    )
  }
  return null
}

function SettingsMenu({ groups, state }: { groups: readonly SettingsGroup[]; state: MenuState }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active = activeSection(groups, pathname)

  return (
    <>
      {/* Below `lg`: one select of the same groups — a phone keeps the width for the section. */}
      <label className="lg:hidden block">
        <span className="sr-only">Settings section</span>
        <select
          className="select select-sm w-full"
          value={active?.path ?? ''}
          onChange={event => navigate(event.target.value)}
        >
          {!active && <option value="">Choose a section</option>}
          {groups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.sections.map(section => (
                <option key={section.id} value={section.path}>
                  {section.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <nav aria-label="Settings" className="hidden lg:block space-y-5">
        {groups.map(group => {
          const headingId = `settings-group-${group.label.toLowerCase().replace(/\W+/g, '-')}`
          return (
            <div key={group.label}>
              <div id={headingId} className="nav-group-label px-2.5 pb-1.5">
                {group.label}
              </div>
              <ul aria-labelledby={headingId} className="space-y-0.5">
                {group.sections.map(section => (
                  <li key={section.id}>
                    <NavLink
                      to={section.path}
                      // NavLink sets `aria-current="page"` on its own (prefix) match; sections
                      // never nest, so that is the same entry `activeSection` picks.
                      data-active={section.id === active?.id}
                      className="nav-item flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm"
                    >
                      <span className="truncate">{section.label}</span>
                      <MenuAdornment section={section} state={state} />
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>
    </>
  )
}

/**
 * Tabs INSIDE a section (People, AI & models) — links to real paths, so a tab is a URL too. Only
 * the tabs the reader may open are listed, and with just one there is no bar at all.
 */
function SectionTabs({
  label,
  tabs,
  pendingRequests = 0,
}: {
  label: string
  tabs: readonly SettingsSubTab[]
  pendingRequests?: number
}) {
  if (tabs.length < 2) return null
  return (
    <nav aria-label={label} className="mb-6 border-b border-[color:var(--border-default)]">
      <ul className="tabs tabs-border">
        {tabs.map(tab => (
          <li key={tab.path} className="contents">
            <NavLink
              to={tab.path}
              end
              className={({ isActive }) =>
                `tab gap-2 ${isActive ? 'tab-active font-semibold' : ''}`
              }
            >
              {tab.label}
              {tab.badge === 'accessRequests' && pendingRequests > 0 && (
                <span className="badge badge-sm badge-warning tabular-nums">
                  {pendingRequests}
                  <span className="sr-only"> waiting</span>
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Members, groups and the sign-up queue: three tabs, each guarded as it was on its own. */
function PeopleSection({ pendingRequests }: { pendingRequests: number }) {
  const canAccess = useNavGuard()
  const tabs = PEOPLE_TABS.filter(tab => canAccess(tab.guard))
  const [members, groups, requests] = PEOPLE_TABS
  return (
    <>
      <SectionTabs label="People" tabs={tabs} pendingRequests={pendingRequests} />
      <Routes>
        <Route
          index
          element={
            canAccess(members.guard) ? (
              <People />
            ) : (
              // A global admin with no membership has only the queue.
              <Navigate to={tabs[0]?.path ?? SETTINGS_PATH} replace />
            )
          }
        />
        <Route
          path="groups"
          element={
            <RequireGuard guard={groups.guard} redirectTo={SETTINGS_PATH}>
              <GroupsSettings />
            </RequireGuard>
          }
        />
        <Route
          path="access-requests"
          element={
            <RequireGuard guard={requests.guard} redirectTo={SETTINGS_PATH}>
              <AccessRequests />
            </RequireGuard>
          }
        />
        <Route path="*" element={<Navigate to={SETTINGS_PATHS.people} replace />} />
      </Routes>
    </>
  )
}

/** The organisation's AI providers, and which model each agent or feature uses. */
function AiSection() {
  const canAccess = useNavGuard()
  const [providers, agentModels] = AI_TABS
  return (
    <>
      <SectionTabs label="AI & models" tabs={AI_TABS.filter(tab => canAccess(tab.guard))} />
      <Routes>
        <Route index element={<AiSettings />} />
        <Route
          path="agent-models"
          element={
            <RequireGuard guard={agentModels.guard} redirectTo={providers.path}>
              <AgentModelsSettings />
            </RequireGuard>
          }
        />
        <Route path="*" element={<Navigate to={SETTINGS_PATHS.ai} replace />} />
      </Routes>
    </>
  )
}

/**
 * `/settings` itself: an old `?tab=` link goes to where that tab lives now (its hash kept), and
 * anything else to the reader's first section.
 */
function SettingsIndex({
  groups,
  pluginTabIds,
}: {
  groups: readonly SettingsGroup[]
  pluginTabIds: readonly string[]
}) {
  const [params] = useSearchParams()
  const { hash } = useLocation()
  const legacy = legacyTabPath(params.get('tab'), pluginTabIds)
  const target = legacy ?? firstSettingsPath(groups)
  if (!target) return <Navigate to="/" replace />
  return <Navigate to={`${target}${hash}`} replace />
}

/** Each section's page, by id. A Platform page is one component, told which step it is. */
function sectionPage(section: SettingsSection, pendingRequests: number, pluginTabs: TabConfig[]) {
  if (section.step) return <Connection step={section.step} />
  switch (section.id) {
    case 'general':
      return <General />
    case 'people':
      return <PeopleSection pendingRequests={pendingRequests} />
    case 'approval-policies':
      return <ApprovalPoliciesSettings />
    case 'api-keys':
      return <ApiKeys />
    case 'coding-agents':
      return <CodingAgents />
    case 'ai':
      return <AiSection />
    case 'prompts':
      return <PromptsSettings />
    case 'kit':
      return <Kit />
    case 'audit':
      return <Audit />
    case 'usage':
      return <UsageSettings />
    case 'users':
      return (
        <Routes>
          <Route index element={<UserList />} />
          <Route path=":id" element={<UserDetail />} />
        </Routes>
      )
    case 'feature-flags':
      return <FeatureFlags />
    case 'sessions':
      return <SessionsAdmin />
    case 'organisations':
      return (
        <Routes>
          <Route index element={<TenantList />} />
          <Route path=":id" element={<TenantDetail />} />
        </Routes>
      )
    default:
      // A plugin's tab (D31): `plugin:<its id>`, listed only when the plugin offered it.
      return pluginTabs.find(tab => section.id === `plugin:${tab.id}`)?.content ?? null
  }
}

/** `/settings/general` → `general/*`: the route a section owns under this layout. */
const routeOf = (section: SettingsSection) => `${section.path.slice(SETTINGS_PATH.length + 1)}/*`

export default function SettingsLayout() {
  const { tenant, tenancyMode } = useAuth()
  const canAccess = useNavGuard()
  const { can } = usePermissions()
  const single = tenancyMode === 'single'
  const platformAdmin = canAccess('platformAdmin')

  // D31: installed plugins' tabs, each handed `can` to decide for itself — a tab that would 403 on
  // save is worse than none. `can` is widened to strings on the way out, the same way a `NavGuard`
  // pair is: a plugin's subjects are not in the kit's union until it is installed.
  const pluginTabs: TabConfig[] = canAccess('admin')
    ? uiPlugins.flatMap(
        p =>
          p.settingsTabs?.({
            can: (action, subject) => can(action as Actions, subject as Subjects),
          }) ?? []
      )
    : []

  const all = settingsGroups({ single, pluginTabs })
  const groups = visibleSettingsGroups(all, canAccess)

  const setup = useSetupOverview(platformAdmin)
  const pending = useAdminAccessRequests(
    { status: 'pending', pageSize: 1 },
    { enabled: platformAdmin }
  )
  const pendingRequests = pending.data?.pagination.total ?? 0
  const state: MenuState = {
    stepStatus: step => setup.data?.steps.find(s => s.id === step)?.status,
    pendingRequests,
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description={
          !single && tenant ? `Organisation settings apply to ${tenant.name}.` : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsMenu groups={groups} state={state} />
        <div className="min-w-0">
          <Routes>
            <Route
              index
              element={
                <SettingsIndex groups={groups} pluginTabIds={pluginTabs.map(tab => tab.id)} />
              }
            />
            {all
              .flatMap(group => group.sections)
              .map(section => (
                <Route
                  key={section.id}
                  path={routeOf(section)}
                  element={
                    <RequireGuard guard={section.guard} redirectTo={SETTINGS_PATH}>
                      {sectionPage(section, pendingRequests, pluginTabs)}
                    </RequireGuard>
                  }
                />
              ))}
            {/* One organisation has no list: its settings are General. (Multi mode's is in `all`.) */}
            {single && (
              <Route
                path="organisations/*"
                element={<Navigate to={SETTINGS_PATHS.general} replace />}
              />
            )}
            <Route path="*" element={<Navigate to={SETTINGS_PATH} replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
