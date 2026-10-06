/**
 * Settings → Approvals (Launch P4, plan §1.5): per kind, the organisation's policy — its row, or
 * the default the SERVER reports — and the team/app overrides. Editing posts
 * `putApprovalPolicySchema` (the route's own schema); an override needs its team or app chosen;
 * "Use default" / "Remove" delete the row after a confirmation.
 */
import {
  APPROVAL_KINDS,
  type ApprovalKind,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApprovalPoliciesSettings from '@/ui/pages/settings/ApprovalPolicies'
import { APP_ID } from './helpers/approvals'
import {
  IDS,
  makeSession,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const ROW_ID = '99999999-0000-4000-8000-000000000001'

const defaults = Object.fromEntries(
  APPROVAL_KINDS.map(kind => [kind, DEFAULT_APPROVAL_POLICIES[kind]])
) as Record<ApprovalKind, unknown>

const policyRow = (overrides: Record<string, unknown> = {}) => ({
  ...DEFAULT_APPROVAL_POLICIES['deploy.production'],
  id: ROW_ID,
  kind: 'deploy.production',
  scopeType: 'app',
  scopeId: APP_ID,
  minApprovals: 2,
  updatedByUserId: IDS.user,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

function renderPolicies(routes: RouteTable) {
  const fetchMock = stubFetch({
    '/api/groups': {
      items: [
        {
          id: GROUP_ID,
          tenantId: IDS.tenant,
          groupTypeId: GROUP_ID,
          typeName: 'Team',
          name: 'Platform',
          description: null,
          memberCount: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    '/api/apps': {
      items: [
        {
          id: APP_ID,
          slug: 'expenses',
          displayName: 'Expenses',
          description: null,
          status: 'live',
          source: 'created',
          template: 'rocketflare',
          templateVersion: null,
          repoOwner: 'acme',
          repoName: 'expenses',
          ownerGroup: null,
          environments: [],
          createdAt: new Date().toISOString(),
        },
      ],
      appsDomain: null,
    },
    '/api/members': { items: [], pagination: { page: 1, pageSize: 200, total: 0, totalPages: 1 } },
    ...routes,
  })
  renderWithProviders(<ApprovalPoliciesSettings />, { session: makeSession() })
  return fetchMock
}

describe('ApprovalPoliciesSettings', () => {
  it('shows each kind with the default it falls back to, and the overrides', async () => {
    renderPolicies({ '/api/approval-policies': { items: [policyRow()], defaults } })
    expect(await screen.findByRole('heading', { name: 'Production deploy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'New app' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'App access' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Session budget' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Secret access' })).toBeInTheDocument()
    // Issue #5: `session.merge` is the sixth built kind.
    expect(screen.getByRole('heading', { name: 'Session merge' })).toBeInTheDocument()
    // Five kinds show Launch's default; `session.merge` with no row is "Not required" instead.
    expect(screen.getAllByText('default')).toHaveLength(5)
    expect(screen.getByText(/App: Expenses/)).toBeInTheDocument()
    expect(
      screen.getByText('2 approvals from the app’s owners or the organisation’s admins')
    ).toBeInTheDocument()
  })

  it('edits the organisation policy with the route’s schema', async () => {
    const fetchMock = renderPolicies({
      '/api/approval-policies': { items: [], defaults },
      'PUT /api/approval-policies': (init: RequestInit | undefined) => ({
        ...policyRow({ scopeType: 'tenant', scopeId: null }),
        ...JSON.parse(String(init?.body)),
        id: ROW_ID,
      }),
    })
    const panel = (await screen.findByRole('heading', { name: 'Production deploy' })).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: /Edit/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Approvals needed'), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByText(/Teams/))
    fireEvent.click(within(dialog).getByLabelText('Platform (Team)'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toEqual({
        kind: 'deploy.production',
        scopeType: 'tenant',
        scopeId: null,
        approvers: { appOwners: true, admins: true, groupIds: [GROUP_ID], userIds: [] },
        minApprovals: 2,
        allowSelfApproval: false,
        expiresAfterMinutes: 24 * 60,
        autoApproveRole: null,
      })
    )
  })

  it('needs a team or app chosen before an override saves', async () => {
    const fetchMock = renderPolicies({
      '/api/approval-policies': { items: [], defaults },
      'PUT /api/approval-policies': () => policyRow(),
    })
    const panel = (await screen.findByRole('heading', { name: 'App access' })).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(panel).getByText('Override'))
    fireEvent.click(within(panel).getByRole('button', { name: 'For an app' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Choose an app')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toBeUndefined()

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'App' }), {
      target: { value: APP_ID },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toMatchObject({
        kind: 'app.access',
        scopeType: 'app',
        scopeId: APP_ID,
      })
    )
  })

  it('refuses a policy nobody could ever approve', async () => {
    const fetchMock = renderPolicies({ '/api/approval-policies': { items: [], defaults } })
    const panel = (await screen.findByRole('heading', { name: 'App access' })).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: /Edit/ }))
    const dialog = screen.getByRole('dialog')
    // App access defaults to the app's owners and the organisation's admins: untick both.
    fireEvent.click(within(dialog).getByLabelText(/The app’s owners/))
    fireEvent.click(within(dialog).getByLabelText(/The organisation’s admins/))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText(/Name at least one approver/)).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toBeUndefined()
  })

  it('lets a shared-config policy name nobody: the resource’s owner team always decides', async () => {
    const fetchMock = renderPolicies({
      '/api/approval-policies': { items: [], defaults },
      'PUT /api/approval-policies': (init: RequestInit | undefined) => ({
        ...policyRow({ scopeType: 'tenant', scopeId: null }),
        ...JSON.parse(String(init?.body)),
        id: ROW_ID,
      }),
    })
    const panel = (await screen.findByRole('heading', { name: 'Secret access' })).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: /Edit/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/owner team always may/)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Approvals needed'), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toMatchObject({
        kind: 'grant.request',
        approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
        minApprovals: 2,
      })
    )
    expect(within(dialog).queryByText(/Name at least one approver/)).toBeNull()
  })

  describe('Required / Not required, in plain words (issue #22)', () => {
    const panelOf = async (name: string) =>
      (await screen.findByRole('heading', { name })).closest('section') as HTMLElement
    const tenantRow = (kind: string, overrides: Record<string, unknown> = {}) =>
      policyRow({
        ...DEFAULT_APPROVAL_POLICIES[kind as ApprovalKind],
        kind,
        scopeType: 'tenant',
        scopeId: null,
        minApprovals: 1,
        ...overrides,
      })
    const echo = (init: RequestInit | undefined) => ({
      ...policyRow({ scopeType: 'tenant', scopeId: null }),
      ...JSON.parse(String(init?.body)),
      id: ROW_ID,
    })

    it('session.merge with no organisation row is Not required: each app decides', async () => {
      renderPolicies({ '/api/approval-policies': { items: [], defaults } })
      const panel = await panelOf('Session merge')
      expect(within(panel).getByRole('radio', { name: 'Not required' })).toBeChecked()
      expect(within(panel).getByTestId('requirement-session.merge')).toHaveTextContent(
        'Not required. Each app decides in its Ship settings (default: no review).'
      )
      // Not the code default's "app owners, 1 approval", which read as if review were on.
      expect(within(panel).queryByText(/approval from the app’s owners/)).toBeNull()
      expect(within(panel).queryByRole('button', { name: 'Use default' })).toBeNull()
    })

    it('session.merge with a row is Required for every app; approving every request at once is Always', async () => {
      renderPolicies({
        '/api/approval-policies': {
          items: [tenantRow('session.merge', { id: ROW_ID })],
          defaults,
        },
      })
      const panel = await panelOf('Session merge')
      expect(within(panel).getByRole('radio', { name: 'Required' })).toBeChecked()
      expect(within(panel).getByTestId('requirement-session.merge')).toHaveTextContent(
        'Required for every app: a person approves each change before it merges.'
      )
      cleanup()
      renderPolicies({
        '/api/approval-policies': {
          items: [tenantRow('session.merge', { autoApproveRole: 'member' })],
          defaults,
        },
      })
      const always = await panelOf('Session merge')
      expect(within(always).getByTestId('requirement-session.merge')).toHaveTextContent(
        'Required for every app, and approved automatically: every merge is approved at once. An automatic approval is still recorded and audited.'
      )
      expect(always).toHaveTextContent(
        'approved automatically: always (every request is approved at once)'
      )
    })

    it('turning session.merge review off deletes the organisation row, after saying what follows', async () => {
      const fetchMock = renderPolicies({
        '/api/approval-policies': { items: [tenantRow('session.merge')], defaults },
        [`DELETE /api/approval-policies/${ROW_ID}`]: undefined,
      })
      const panel = await panelOf('Session merge')
      fireEvent.click(within(panel).getByRole('radio', { name: 'Not required' }))
      const dialog = screen.getByRole('dialog')
      expect(
        within(dialog).getByText(/Each app decides in its own Ship settings/)
      ).toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Make it not required' }))
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              init?.method === 'DELETE' && String(input).endsWith(`/approval-policies/${ROW_ID}`)
          )
        ).toBe(true)
      )
    })

    it('requiring session.merge review opens the editor on the default, and saves an organisation row', async () => {
      const fetchMock = renderPolicies({
        '/api/approval-policies': { items: [], defaults },
        'PUT /api/approval-policies': echo,
      })
      const panel = await panelOf('Session merge')
      fireEvent.click(within(panel).getByRole('radio', { name: 'Required' }))
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toMatchObject({
          kind: 'session.merge',
          scopeType: 'tenant',
          scopeId: null,
          approvers: { appOwners: true },
          autoApproveRole: null,
        })
      )
    })

    it('any other kind: Not required approves every request at once, and the row says so', async () => {
      const fetchMock = renderPolicies({
        '/api/approval-policies': { items: [], defaults },
        'PUT /api/approval-policies': echo,
      })
      const panel = await panelOf('Production deploy')
      expect(within(panel).getByRole('radio', { name: 'Required' })).toBeChecked()
      expect(within(panel).getByTestId('requirement-deploy.production')).toHaveTextContent(
        'Required: a person approves each request'
      )
      fireEvent.click(within(panel).getByRole('radio', { name: 'Not required' }))
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByText(/still recorded and audited/)).toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve automatically' }))
      await waitFor(() =>
        expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toMatchObject({
          kind: 'deploy.production',
          scopeType: 'tenant',
          scopeId: null,
          autoApproveRole: 'member',
        })
      )
    })

    it('a kind set to approve everyone reads Not required; Required takes it back', async () => {
      const fetchMock = renderPolicies({
        '/api/approval-policies': {
          items: [tenantRow('deploy.production', { autoApproveRole: 'member' })],
          defaults,
        },
        'PUT /api/approval-policies': echo,
      })
      const panel = await panelOf('Production deploy')
      expect(within(panel).getByRole('radio', { name: 'Not required' })).toBeChecked()
      expect(within(panel).getByTestId('requirement-deploy.production')).toHaveTextContent(
        'Not required: every request is approved at once. An automatic approval is still recorded and audited.'
      )
      fireEvent.click(within(panel).getByRole('radio', { name: 'Required' }))
      await waitFor(() =>
        expect(requestBody(fetchMock, 'PUT /api/approval-policies')).toMatchObject({
          kind: 'deploy.production',
          autoApproveRole: null,
        })
      )
    })

    it('words auto-approval plainly: Always, by role, or Never — in the list and the editor', async () => {
      renderPolicies({ '/api/approval-policies': { items: [], defaults } })
      // `app.create` approves an admin's own request at once by default.
      const newApp = await panelOf('New app')
      expect(newApp).toHaveTextContent('approved automatically: when an admin or owner asks')
      expect(newApp).toHaveTextContent('An automatic approval is still recorded and audited.')
      const access = await panelOf('App access')
      expect(access).toHaveTextContent('approved automatically: never (a person decides)')
      fireEvent.click(within(access).getByRole('button', { name: /Edit/ }))
      const dialog = screen.getByRole('dialog')
      const options = within(within(dialog).getByLabelText('Approve automatically'))
        .getAllByRole('option')
        .map(o => o.textContent)
      expect(options).toEqual([
        'Never (a person decides)',
        'Always (every request is approved at once)',
        'When an admin or owner asks',
        'When an owner asks',
      ])
    })
  })

  it('removes an override after a confirmation', async () => {
    const fetchMock = renderPolicies({
      '/api/approval-policies': { items: [policyRow()], defaults },
      [`DELETE /api/approval-policies/${ROW_ID}`]: undefined,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/keep the policy they were opened with/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'DELETE' && String(input).endsWith(`/approval-policies/${ROW_ID}`)
        )
      ).toBe(true)
    )
  })
})
