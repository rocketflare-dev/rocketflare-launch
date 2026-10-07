/**
 * Settings is one place (`pages/settings/SettingsLayout.tsx`, mounted by `settingsRoutes()`): the
 * grouped menu each ROLE sees through the real `useNavGuard` — owner, admin, member, global admin,
 * a global admin with no membership, in single and multi mode — the active entry, the setup dots
 * and the access-request count, and every redirect from the three areas it replaced.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Suspense } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsRoutes } from '@/ui/components/SettingsRoutes'
import {
  IDS,
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'
import { setupOverview } from './helpers/setup'

afterEach(() => vi.unstubAllGlobals())
// `settingsRoutes()` mounts the layout lazily; load its module once so no test waits on the import.
beforeAll(async () => {
  await import('@/ui/pages/settings/SettingsLayout')
})

type Session = ReturnType<typeof makeSession>

function Where() {
  const { pathname, search, hash } = useLocation()
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>
}

function renderAt(route: string, session: Session, routes: Record<string, unknown> = {}) {
  const fetchMock = stubFetch({
    '/api/platform/setup': setupOverview,
    '/api/platform/access-requests': {
      items: [],
      pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
    },
    ...routes,
  })
  renderWithProviders(
    <>
      <Suspense fallback={null}>
        <Routes>
          {settingsRoutes()}
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </Suspense>
      <Where />
    </>,
    { route, session }
  )
  return fetchMock
}

const where = () => screen.getByTestId('where').textContent

/** The menu as `{ group: [section, …] }`, read from the landmark the way a reader meets it. */
async function menu(): Promise<Record<string, string[]>> {
  // The layout is a lazy chunk: its first load in a busy run can outlast the default second.
  const nav = await screen.findByRole('navigation', { name: 'Settings' }, { timeout: 5000 })
  const out: Record<string, string[]> = {}
  for (const list of within(nav).getAllByRole('list')) {
    const heading = document.getElementById(list.getAttribute('aria-labelledby') ?? '')
    out[heading?.textContent ?? '?'] = within(list)
      .getAllByRole('link')
      .map(link => link.querySelector('span')?.textContent ?? '')
  }
  return out
}

const CONNECTIONS = ['Domain', 'Cloudflare', 'Neon', 'GitHub', 'Email', 'Sign-in', 'Public URL']
const ORGANISATION = ['General', 'People', 'Approval policies', 'API keys']

const owner = (tenancyMode: 'single' | 'multi') =>
  makeSession({ tenancyMode, tenant: makeTenant({ role: 'owner' }) })
const admin = (tenancyMode: 'single' | 'multi') =>
  makeSession({ tenancyMode, tenant: makeTenant({ role: 'admin' }) })
const member = (tenancyMode: 'single' | 'multi') =>
  makeSession({ tenancyMode, tenant: makeTenant({ role: 'member' }) })
const globalAdmin = (tenancyMode: 'single' | 'multi') =>
  makeSession({
    tenancyMode,
    user: makeUser({ isGlobalAdmin: true }),
    tenant: makeTenant({ role: 'member' }),
  })
const globalAdminAlone = () =>
  makeSession({
    tenancyMode: 'multi',
    user: makeUser({ isGlobalAdmin: true }),
    tenant: null,
    tenants: [],
  })

describe('Settings — what each role sees', () => {
  it('multi-mode owner: the organisation, its AI and its activity — no connections or operator', async () => {
    renderAt('/settings/general', owner('multi'))
    expect(await menu()).toEqual({
      Organisation: ORGANISATION,
      'Building apps': ['AI & models', 'Prompts'],
      Activity: ['Audit', 'Usage'],
    })
  })

  it('single-mode owner: also the deployment — connections, coding agents, the kit', async () => {
    renderAt('/settings/general', owner('single'))
    expect(await menu()).toEqual({
      Organisation: ORGANISATION,
      'Building apps': ['Coding agents', 'AI & models', 'Prompts', 'Kit version'],
      Platform: CONNECTIONS,
      Activity: ['Audit', 'Usage'],
    })
  })

  it('single-mode admin: the same sections as the owner', async () => {
    renderAt('/settings/general', admin('single'))
    const seen = await menu()
    expect(seen.Platform).toEqual(CONNECTIONS)
    expect(seen.Organisation).toEqual(ORGANISATION)
    expect(seen.Operator).toBeUndefined()
  })

  it('member: no Settings at all, and a deep link goes home', async () => {
    renderAt('/settings/general', member('single'))
    await waitFor(() => expect(where()).toBe('/'))
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
  })

  it('member: an operator section bounces too', async () => {
    renderAt('/settings/users', member('multi'))
    await waitFor(() => expect(where()).toBe('/'))
  })

  it('multi-mode global admin: everything, Organisations included', async () => {
    renderAt('/settings/general', globalAdmin('multi'))
    expect(await menu()).toEqual({
      Organisation: ORGANISATION,
      'Building apps': ['Coding agents', 'AI & models', 'Prompts', 'Kit version'],
      Platform: CONNECTIONS,
      Activity: ['Audit', 'Usage'],
      Operator: ['Users', 'Feature flags', 'All sessions', 'Organisations'],
    })
  })

  it('single-mode global admin: the Operator group has no Organisations list', async () => {
    renderAt('/settings/general', globalAdmin('single'))
    expect((await menu()).Operator).toEqual(['Users', 'Feature flags', 'All sessions'])
  })

  it('global admin with no membership: People (for the queue), the deployment and the operator', async () => {
    renderAt('/settings', globalAdminAlone())
    expect(await menu()).toEqual({
      Organisation: ['People'],
      'Building apps': ['Coding agents', 'Kit version'],
      Platform: CONNECTIONS,
      Operator: ['Users', 'Feature flags', 'All sessions', 'Organisations'],
    })
    // `/settings` → People → the one tab they may open.
    await waitFor(() => expect(where()).toBe('/settings/people/access-requests'))
  })

  it('an organisation owner who opens an operator section lands on their first section', async () => {
    renderAt('/settings/users', owner('multi'))
    await waitFor(() => expect(where()).toBe('/settings/general'))
  })
})

describe('Settings — the menu', () => {
  it('marks the section the reader is in, sub-tabs included', async () => {
    renderAt('/settings/people/groups', owner('single'))
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    const people = within(nav).getByRole('link', { name: /^People/ })
    expect(people).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: /^General/ })).not.toHaveAttribute('aria-current')
    // People's own tabs: members, groups and the queue, with what is waiting.
    const tabs = screen.getByRole('navigation', { name: 'People' })
    const links = within(tabs).getAllByRole('link')
    await waitFor(() =>
      expect(links.map(l => l.textContent)).toEqual([
        'Members',
        'Groups',
        'Access requests2 waiting',
      ])
    )
    expect(links[1]).toHaveAttribute('aria-current', 'page')
    // DaisyUI styles a `.tab` only as a direct child of `.tabs`: wrapped, they render as run-on text.
    expect(tabs).toHaveClass('tabs')
    for (const link of links) {
      expect(link).toHaveClass('tab')
      expect(link.parentElement).toBe(tabs)
    }
  })

  it('shows each connection with its status dot, and the access-request count on People', async () => {
    renderAt('/settings/general', owner('single'))
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    await waitFor(() =>
      expect(
        within(nav)
          .getByRole('link', { name: /^Email/ })
          .querySelector('[data-status]')
      ).toHaveAttribute('data-status', 'failed')
    )
    expect(
      within(nav)
        .getByRole('link', { name: /^Domain/ })
        .querySelector('[data-status]')
    ).toHaveAttribute('data-status', 'ok')
    expect(within(nav).getByRole('link', { name: /^People/ })).toHaveTextContent('2 waiting')
  })

  it('never asks for platform state when the reader cannot see it', async () => {
    const fetchMock = renderAt('/settings/general', owner('multi'))
    await menu()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/platform/'))).toBe(
      false
    )
  })

  it('collapses into one select of the same groups on a small screen', async () => {
    renderAt('/settings/general', owner('single'))
    const select = await screen.findByRole('combobox', { name: 'Settings section' })
    expect(select).toHaveValue('/settings/general')
    expect(
      Array.from(select.querySelectorAll('optgroup')).map(g => g.getAttribute('label'))
    ).toEqual(['Organisation', 'Building apps', 'Platform', 'Activity'])
    fireEvent.change(select, { target: { value: '/settings/kit' } })
    await waitFor(() => expect(where()).toBe('/settings/kit'))
  })
})

describe('Settings — every old address still works', () => {
  it.each([
    ['/settings', '/settings/general'],
    ['/settings?tab=general', '/settings/general'],
    ['/settings?tab=people', '/settings/people'],
    ['/settings?tab=groups', '/settings/people/groups'],
    ['/settings?tab=api-keys', '/settings/api-keys'],
    ['/settings?tab=approvals', '/settings/approval-policies'],
    ['/settings?tab=ai', '/settings/ai'],
    ['/settings?tab=agent-models', '/settings/ai/agent-models'],
    ['/settings?tab=prompts', '/settings/prompts'],
    ['/settings?tab=usage', '/settings/usage'],
    ['/audit', '/settings/audit'],
    ['/activity', '/settings/audit'],
    ['/settings/platform', '/settings/domain'],
    ['/settings/platform/setup', '/settings/domain'],
    ['/settings/platform/setup#setup-public_url', '/settings/public-url'],
    ['/settings/platform/kit', '/settings/kit'],
    ['/settings/platform/coding-agents', '/settings/coding-agents'],
    ['/settings/platform/identity', '/settings/sign-in'],
    ['/settings/platform/access-requests', '/settings/people/access-requests'],
    ['/admin/setup#setup-resend', '/settings/email'],
    ['/admin/identity', '/settings/sign-in'],
    ['/admin/access-requests', '/settings/people/access-requests'],
  ])('single-mode owner: %s → %s', async (from, to) => {
    renderAt(from, owner('single'))
    await waitFor(() => expect(where()).toBe(to))
  })

  it.each([
    ['/admin', '/settings/users'],
    ['/admin/users', '/settings/users'],
    [`/admin/users/${IDS.user}`, `/settings/users/${IDS.user}`],
    ['/admin/feature-flags', '/settings/feature-flags'],
    ['/admin/sessions', '/settings/sessions'],
    ['/admin/tenants', '/settings/organisations'],
    [`/admin/tenants/${IDS.tenant}`, `/settings/organisations/${IDS.tenant}`],
  ])('multi-mode global admin: %s → %s', async (from, to) => {
    renderAt(from, globalAdmin('multi'))
    await waitFor(() => expect(where()).toBe(to))
  })

  it('single mode has no organisations list: the old address lands on General', async () => {
    renderAt(`/admin/tenants/${IDS.tenant}`, globalAdmin('single'))
    await waitFor(() => expect(where()).toBe('/settings/general'))
  })

  it('keeps the query string of an address that moved', async () => {
    renderAt('/audit?action=member', owner('single'))
    await waitFor(() => expect(where()).toBe('/settings/audit?action=member'))
  })
})
