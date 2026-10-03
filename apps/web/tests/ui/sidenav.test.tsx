import { HomeIcon } from '@heroicons/react/24/outline'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SideNav, {
  activeNavPath,
  badgeValueFor,
  composeNav,
  DEFAULT_NAV_ANCHOR,
  filterNavConfig,
  isPathActive,
  type NavConfig,
  navigationConfig,
} from '@/ui/components/SideNav'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import {
  makeSession,
  renderWithProviders,
  stubFetch,
  stubHealthFetch,
} from './helpers/renderWithProviders'

const guardMock = vi.fn<(guard: NavGuard | undefined) => boolean>(() => true)
vi.mock('@/ui/hooks/useNavGuard', async importOriginal => {
  const mod = await importOriginal<typeof import('@/ui/hooks/useNavGuard')>()
  return { ...mod, useNavGuard: () => guardMock }
})

const config: NavConfig = [
  { items: [{ to: '/', label: 'Home', icon: HomeIcon }] },
  {
    label: 'Organisation',
    items: [{ to: '/settings', label: 'Settings', icon: HomeIcon, guard: 'admin' }],
  },
  {
    label: 'Platform',
    items: [{ to: '/admin', label: 'Admin', icon: HomeIcon, guard: 'globalAdmin' }],
  },
  {
    to: '/reports',
    label: 'Reports',
    icon: HomeIcon,
    guard: { action: 'read', subject: 'Report' },
  },
  {
    to: '/agents',
    label: 'Agents',
    icon: HomeIcon,
    badgeKey: 'agentsAwaiting',
    badgeTone: 'warning',
  },
]

/** `GET /api/agents/interrupts` is the badge's only source; it reads `pagination.total`. */
function stubAwaiting(total: number) {
  return stubFetch({
    '/api/health': { status: 'ok', version: '1.2.3', env: 'staging' },
    '/api/agents/interrupts': {
      items: [],
      pagination: { page: 1, pageSize: 1, total, totalPages: total },
    },
  })
}

describe('filterNavConfig', () => {
  it('drops guarded items and empties groups', () => {
    const visible = filterNavConfig(config, guard => guard === undefined || guard === 'admin')
    const labels = visible
      .flatMap(item => ('items' in item ? item.items : [item]))
      .map(i => i.label)
    expect(labels).toEqual(['Home', 'Settings', 'Agents'])
    // The Platform group vanished entirely rather than rendering an empty heading
    expect(visible.some(item => 'label' in item && item.label === 'Platform')).toBe(false)
  })

  it('drops an UNLABELLED group whose items are all guarded away — no empty block, no gap', () => {
    const hidden: NavGuard = { feature: 'kit-ai' }
    const visible = filterNavConfig(
      [
        { items: [{ to: '/', label: 'Home', icon: HomeIcon }] },
        {
          items: [
            { to: '/chat', label: 'Chat', icon: HomeIcon, guard: hidden },
            { to: '/agents', label: 'Agents', icon: HomeIcon, guard: hidden },
          ],
        },
        { label: 'Organisation', items: [{ to: '/audit', label: 'Audit', icon: HomeIcon }] },
      ],
      guard => guard !== hidden
    )
    expect(visible).toHaveLength(2)
    expect(visible.every(item => 'items' in item && item.items.length > 0)).toBe(true)
  })
})

describe('composeNav', () => {
  // D31: where a plugin's nav group lands. Pure, so it is tested rather than reasoned about — the
  // failure mode is a plugin whose pages exist and have no way in, which nothing else would catch.
  const item = (to: string) => ({ to, label: to, icon: HomeIcon })
  const plugin = { items: [item('/orders')] }

  it('puts a group before the anchor group by default', () => {
    const out = composeNav(config, [plugin])
    const labels = out.map(e => ('items' in e ? (e.label ?? '(unlabelled)') : e.label))
    expect(labels.indexOf('(unlabelled)')).toBeLessThan(labels.indexOf(DEFAULT_NAV_ANCHOR))
  })

  it('honours an explicit anchor, and keeps declaration order for several', () => {
    const out = composeNav(config, [
      { label: 'A', items: [item('/a')], before: 'Platform' },
      { label: 'B', items: [item('/b')], before: 'Platform' },
    ])
    const labels = out.filter(e => 'items' in e).map(e => e.label)
    expect(labels.indexOf('A')).toBeLessThan(labels.indexOf('B'))
    expect(labels.indexOf('B')).toBeLessThan(labels.indexOf('Platform'))
  })

  it('appends when the anchor is not there — an app that deleted it still gets the pages', () => {
    const out = composeNav([{ items: [item('/')] }], [{ label: 'A', items: [item('/a')] }])
    expect(out).toHaveLength(2)
    expect((out[1] as { label?: string }).label).toBe('A')
  })

  it('MERGES an unlabelled group into the unlabelled group it lands after, keeping order', () => {
    // The analytics plugin's case: no label, no `before` → it lands after the kit's unlabelled
    // first group, and joins it rather than floating alone after a group gap.
    const out = composeNav(config, [
      { items: [item('/analytics')] },
      { items: [item('/orders'), item('/reports')] },
    ])
    expect(out).toHaveLength(config.length)
    const first = out[0] as { label?: string; items: { to: string }[] }
    expect(first.label).toBeUndefined()
    expect(first.items.map(i => i.to)).toEqual(['/', '/analytics', '/orders', '/reports'])
  })

  it('merges with an explicit anchor too, when the group before it is unlabelled', () => {
    const out = composeNav(config, [{ items: [item('/x')], before: 'Organisation' }])
    expect((out[0] as { items: { to: string }[] }).items.map(i => i.to)).toEqual(['/', '/x'])
  })

  it('keeps an unlabelled group separate when it lands after a LABELLED group', () => {
    const out = composeNav(config, [{ items: [item('/x')], before: 'Platform' }])
    expect(out).toHaveLength(config.length + 1)
    const at = out.findIndex(e => 'items' in e && e.items.some(i => i.to === '/x'))
    expect((out[at - 1] as { label?: string }).label).toBe('Organisation')
    expect((out[at] as { label?: string }).label).toBeUndefined()
  })

  it('never merges a LABELLED group, even after an unlabelled one', () => {
    const out = composeNav(config, [{ label: 'Orders', items: [item('/orders')] }])
    expect(out).toHaveLength(config.length + 1)
    expect((out[1] as { label?: string }).label).toBe('Orders')
    expect((out[0] as { items: unknown[] }).items).toHaveLength(1)
  })

  it('does not mutate the core config', () => {
    const before = config.length
    const firstItems = (config[0] as { items: unknown[] }).items.length
    composeNav(config, [plugin, plugin])
    expect(config).toHaveLength(before)
    expect((config[0] as { items: unknown[] }).items).toHaveLength(firstItems)
  })

  it('is the identity with no plugins installed — which is the kit today', () => {
    expect(composeNav(config)).toEqual(config)
  })
})

describe('navigationConfig', () => {
  const groups = navigationConfig.filter(e => 'items' in e) as {
    label?: string
    items: { to: string }[]
  }[]

  it('puts the analytics plugin item IN the first group, not in a group of its own', () => {
    expect(groups[0]?.label).toBeUndefined()
    expect(groups[0]?.items.map(i => i.to)).toContain('/analytics')
    expect(groups.filter(g => g.label === undefined)).toHaveLength(1)
  })

  it('lists Audit as the one log — no Activity item', () => {
    const tos = groups.flatMap(g => g.items.map(i => i.to))
    expect(tos).toContain('/audit')
    expect(tos).not.toContain('/activity')
  })
})

describe('isPathActive', () => {
  it('matches "/" exactly and other paths by segment', () => {
    expect(isPathActive('/', '/')).toBe(true)
    expect(isPathActive('/settings', '/')).toBe(false)
    expect(isPathActive('/settings/people', '/settings')).toBe(true)
    expect(isPathActive('/settingsx', '/settings')).toBe(false)
  })
})

describe('activeNavPath', () => {
  it('lights the most specific entry alone — Setup under Settings, not both', () => {
    const tos = ['/', '/settings', '/settings/platform', '/admin']
    expect(activeNavPath('/settings/platform/setup', tos)).toBe('/settings/platform')
    expect(activeNavPath('/settings', tos)).toBe('/settings')
    expect(activeNavPath('/settings/people', tos)).toBe('/settings')
    expect(activeNavPath('/', tos)).toBe('/')
    expect(activeNavPath('/elsewhere', tos)).toBeUndefined()
  })
})

describe('SideNav', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    guardMock.mockReset()
    guardMock.mockImplementation(() => true)
  })

  it('shows everything when the guard allows all (Phase 0 default)', async () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />)

    expect(screen.getByRole('link', { name: /^Home/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Settings/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Admin/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Reports/ })).toBeInTheDocument()
    // The version footer comes from /api/health
    await waitFor(() => expect(screen.getByText('v1.2.3')).toBeInTheDocument())
  })

  it('hides items whose guard is denied', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    guardMock.mockImplementation(guard => guard === undefined)
    renderWithProviders(<SideNav items={config} />, { route: '/settings/people' })

    expect(screen.getByRole('link', { name: /^Home/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reports/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Platform')).not.toBeInTheDocument()
  })

  it('marks the current section active', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />, { route: '/settings/people' })
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('link', { name: /^Home/ })).toHaveAttribute('data-active', 'false')
  })

  it('renders the live badge, and a DOT on the icon when collapsed', async () => {
    // Without the dot the whole "something is waiting on you" feature is invisible to everyone who
    // collapsed the sidebar — which is most people who have used the app for a week.
    stubAwaiting(3)
    renderWithProviders(<SideNav items={config} />, { session: makeSession() })
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
    expect(screen.queryByTestId('nav-badge-dot-agentsAwaiting')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    await waitFor(() =>
      expect(screen.getByTestId('nav-badge-dot-agentsAwaiting')).toBeInTheDocument()
    )
    // The count is still announced, so it is not dot-only for a screen reader.
    expect(screen.getByRole('link', { name: /3 waiting for you/ })).toBeInTheDocument()
  })

  it('renders no badge when nothing is waiting — an empty inbox is not a nought', async () => {
    stubAwaiting(0)
    renderWithProviders(<SideNav items={config} />, { session: makeSession() })
    await waitFor(() => expect(screen.getByRole('link', { name: /Agents/ })).toBeInTheDocument())
    expect(
      badgeValueFor({ to: '/x', label: 'x', icon: HomeIcon, badgeKey: 'agentsAwaiting' }, {})
    ).toBeUndefined()
    expect(screen.queryByTestId('nav-badge-dot-agentsAwaiting')).not.toBeInTheDocument()
  })

  it('persists the collapsed preference', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    expect(localStorage.getItem('sideNavCollapsed')).toBe('true')
  })
})
