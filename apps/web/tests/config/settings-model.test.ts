/**
 * Settings as data (`pages/settings/settingsModel.ts`, `lib/settings-paths.ts`): which groups and
 * sections exist in each mode, that a guard empties a group rather than leaving a heading, where
 * `/settings` lands, where every old `?tab=` and setup-wizard anchor goes, and Home's setup
 * checklist. The per-ROLE answers, through the real `useNavGuard`, are `tests/ui/settings-layout`.
 */
import { describe, expect, it } from 'vitest'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import {
  CONNECTION_ORDER,
  legacySetupPath,
  legacyTabPath,
  SETTINGS_PATHS,
} from '@/ui/lib/settings-paths'
import { connectionChecks, setupChecklist } from '@/ui/pages/home/homeModel'
import {
  firstSettingsPath,
  settingsGroups,
  visibleSettingsGroups,
} from '@/ui/pages/settings/settingsModel'

const labels = (groups: ReturnType<typeof settingsGroups>) =>
  Object.fromEntries(groups.map(g => [g.label, g.sections.map(s => s.label)]))

describe('settingsGroups', () => {
  it('lays out the five kit groups, in order, with every section', () => {
    expect(labels(settingsGroups({ single: false }))).toEqual({
      Organisation: ['General', 'People', 'Approval policies', 'API keys'],
      'Building apps': ['Coding agents', 'AI & models', 'Prompts', 'Kit version'],
      Platform: ['Domain', 'Cloudflare', 'Neon', 'GitHub', 'Email', 'Sign-in', 'Public URL'],
      Activity: ['Audit', 'Usage'],
      Operator: ['Users', 'Feature flags', 'All sessions', 'Organisations'],
      Plugins: [],
    })
  })

  it('has no Organisations list in single mode — the one organisation is General', () => {
    const operator = settingsGroups({ single: true }).find(g => g.label === 'Operator')
    expect(operator?.sections.map(s => s.id)).toEqual(['users', 'feature-flags', 'sessions'])
  })

  it('gives every section a unique path under /settings, and plugin tabs a namespaced one', () => {
    const all = settingsGroups({
      single: false,
      pluginTabs: [{ id: 'general', label: 'Reports' }],
    }).flatMap(g => g.sections)
    const paths = all.map(s => s.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.every(p => p.startsWith('/settings/'))).toBe(true)
    // A plugin tab named like a kit section cannot shadow it.
    expect(all.find(s => s.id === 'plugin:general')?.path).toBe('/settings/plugins/general')
  })

  it('puts each connection behind platformAdmin and carries its setup step for the menu dot', () => {
    const connections = settingsGroups({ single: true }).find(g => g.label === 'Platform')
    expect(connections?.sections.map(s => s.step)).toEqual([...CONNECTION_ORDER])
    expect(connections?.sections.every(s => s.guard === 'platformAdmin')).toBe(true)
  })
})

describe('visibleSettingsGroups', () => {
  it('drops sections the guard refuses and groups it empties — no heading over nothing', () => {
    // An organisation admin in multi mode: `admin` passes, nothing platform- or operator-wide.
    const orgAdmin = (guard: NavGuard | undefined): boolean => {
      if (guard === undefined || guard === 'admin') return true
      if (typeof guard === 'string') return false
      if (Array.isArray(guard)) return guard.every(orgAdmin)
      if ('anyOf' in guard) return guard.anyOf.some(orgAdmin)
      return 'action' in guard
    }
    const visible = visibleSettingsGroups(settingsGroups({ single: false }), orgAdmin)
    expect(visible.map(g => g.label)).toEqual(['Organisation', 'Building apps', 'Activity'])
    expect(visible[1]?.sections.map(s => s.label)).toEqual(['AI & models', 'Prompts'])
    expect(firstSettingsPath(visible)).toBe(SETTINGS_PATHS.general)
  })

  it('lands on nothing when nothing is visible', () => {
    expect(
      firstSettingsPath(visibleSettingsGroups(settingsGroups({ single: true }), () => false))
    ).toBeNull()
  })
})

describe('old addresses', () => {
  it('maps every old ?tab= to its section, a plugin tab to its namespaced path', () => {
    expect(legacyTabPath('general')).toBe('/settings/general')
    expect(legacyTabPath('people')).toBe('/settings/people')
    expect(legacyTabPath('groups')).toBe('/settings/people/groups')
    expect(legacyTabPath('api-keys')).toBe('/settings/api-keys')
    expect(legacyTabPath('approvals')).toBe('/settings/approval-policies')
    expect(legacyTabPath('ai')).toBe('/settings/ai')
    expect(legacyTabPath('agent-models')).toBe('/settings/ai/agent-models')
    expect(legacyTabPath('prompts')).toBe('/settings/prompts')
    expect(legacyTabPath('usage')).toBe('/settings/usage')
    expect(legacyTabPath('reports', ['reports'])).toBe('/settings/plugins/reports')
    expect(legacyTabPath('nonsense')).toBeNull()
    expect(legacyTabPath('constructor')).toBeNull()
    expect(legacyTabPath(null)).toBeNull()
  })

  it("maps the setup wizard's step anchors to each connection's own page", () => {
    expect(legacySetupPath('#setup-public_url')).toBe('/settings/public-url')
    expect(legacySetupPath('#setup-resend')).toBe('/settings/email')
    expect(legacySetupPath('#setup-identity')).toBe('/settings/sign-in')
    expect(legacySetupPath('#setup-github')).toBe('/settings/github')
    expect(legacySetupPath('')).toBe('/settings/domain')
    expect(legacySetupPath('#setup-toString')).toBe('/settings/domain')
  })
})

describe("Home's setup checklist", () => {
  const steps = (status: Record<string, string>) =>
    CONNECTION_ORDER.map(id => ({ id, status: (status[id] ?? 'ok') as 'ok' }))

  it('counts ok and warning as done, in the menu order, and is complete only when all are', () => {
    const list = setupChecklist(steps({ neon: 'todo', resend: 'failed', identity: 'warning' }))
    expect(list.rows.map(r => r.label)).toEqual([
      'Domain',
      'Cloudflare',
      'Neon',
      'GitHub',
      'Email',
      'Sign-in',
      'Public URL',
    ])
    expect(list.done).toBe(5)
    expect(list.total).toBe(7)
    expect(list.complete).toBe(false)
    expect(list.rows.find(r => r.id === 'resend')?.path).toBe('/settings/email')
    expect(setupChecklist(steps({ identity: 'warning' })).complete).toBe(true)
  })

  it("says what is wrong in the worst probe's words, from the overview's checks", () => {
    const check = (id: string, status: 'ok' | 'warning' | 'failed', detail?: string) => ({
      id,
      label: `${id} label`,
      status,
      detail,
    })
    const checks = connectionChecks({
      credentials: [
        {
          kind: 'cloudflare_api_token',
          lastCheck: [check('zone.found', 'ok'), check('token.write', 'warning')],
        },
        {
          kind: 'resend_api_key',
          lastCheck: [
            check('resend.key', 'warning', 'later'),
            check('resend.domain', 'failed', 'Add and verify the domain.'),
          ],
        },
      ] as never,
      identity: { checks: [check('sso', 'warning')] } as never,
      publicUrl: { checks: [] } as never,
    })
    expect(checks.domain?.map(c => c.id)).toEqual(['zone.found'])
    const list = setupChecklist(
      steps({ cloudflare: 'warning', resend: 'failed', identity: 'warning' }),
      checks
    )
    const reason = (id: string) => list.rows.find(r => r.id === id)?.reason
    expect(reason('domain')).toBeNull()
    expect(reason('cloudflare')).toBe('token.write label')
    expect(reason('resend')).toBe('Add and verify the domain.')
    expect(reason('identity')).toBe('sso label')
  })

  it('treats a step the server did not report as not set', () => {
    const list = setupChecklist([])
    expect(list.done).toBe(0)
    expect(list.rows.every(r => r.status === 'todo')).toBe(true)
  })
})
