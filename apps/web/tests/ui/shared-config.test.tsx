/**
 * Shared config pages (Launch P5, spec/09, plan §4 5f). What they are arranged to get right:
 *
 * - the list shows every resource's value STATUS per environment — never a value — and only an
 *   admin is offered "New shared config";
 * - the resource page tells the owner team what is set ("Set — version 3 … by Carol"), shows var
 *   values to them alone, and its values modal is write-only: set keys read "Set — hidden" with a
 *   Replace button, no input is ever pre-filled, secrets are password inputs, a blank keeps what is
 *   set, and nothing typed is rendered back after saving;
 * - saving on an environment with holders is a rotation: the modal says so and the page shows the
 *   push it started, N/M; a partial push lists the failed apps with Retry;
 * - a member sees names, status and policy (what they need to ask) and no holders, no vars, no
 *   Set button — and the push history is never even requested for them;
 * - Revoke per holder is confirmed and sent to the holder's app.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import { grantPushPollInterval, sharedResourcePollInterval } from '@/ui/hooks/useSharedResources'
import SharedConfigPage from '@/ui/pages/shared-config/SharedConfigPage'
import SharedResourcePage from '@/ui/pages/shared-config/SharedResourcePage'
import {
  holderBehind,
  missingKeys,
  pushProgress,
  valueLine,
} from '@/ui/pages/shared-config/sharedConfigModel'
import {
  APP_ID,
  GRANT_ID,
  GROUP_ID,
  memberDetail,
  ownerDetail,
  PUSH_ID,
  push,
  pushSummary,
  pushTarget,
  RESOURCE_ID,
  resourceRow,
  SENTINEL,
  VERSION_ID,
} from './helpers/grants'
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
  useToastStore.setState({ toasts: [] })
})

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

const DETAIL = `/api/shared-resources/${RESOURCE_ID}`

function renderPages(
  routes: RouteTable,
  { session = makeSession(), route = '/shared-config' } = {}
) {
  const fetchMock = stubFetch({
    '/api/groups': { items: [] },
    '/api/groups/mine': { items: [] },
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/shared-config" element={<SharedConfigPage />} />
      <Route path="/shared-config/:id" element={<SharedResourcePage />} />
    </Routes>,
    { session, route }
  )
  return fetchMock
}

describe('SharedConfigPage', () => {
  it('lists each resource with its status per environment; an admin may create one', async () => {
    renderPages({ '/api/shared-resources': { items: [resourceRow()] } })
    const link = await screen.findByRole('link', { name: 'Microsoft 365' })
    expect(link).toHaveAttribute('href', `/shared-config/${RESOURCE_ID}`)
    const row = link.closest('tr') as HTMLElement
    expect(within(row).getByText('IT Identity')).toBeInTheDocument()
    expect(within(row).getAllByText('v3')).toHaveLength(2)
    expect(within(row).getByText(/· 2 apps/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New shared config/ })).toBeInTheDocument()
  })

  it('a member reads the list but is not offered New', async () => {
    renderPages({ '/api/shared-resources': { items: [] } }, { session: member() })
    expect(await screen.findByText('No shared config yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New shared config/ })).not.toBeInTheDocument()
  })

  it('creates a resource from the modal with the route’s own schema, then opens it', async () => {
    const fetchMock = renderPages({
      '/api/shared-resources': { items: [] },
      '/api/groups': {
        items: [
          {
            id: GROUP_ID,
            tenantId: IDS.tenant,
            groupTypeId: '96000000-0000-4000-8000-0000000000aa',
            typeName: 'Team',
            name: 'IT Identity',
            description: null,
            memberCount: 3,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      'POST /api/shared-resources': () =>
        new Response(JSON.stringify(ownerDetail({ canManage: true })), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      [DETAIL]: ownerDetail({ canManage: true }),
      [`${DETAIL}/pushes`]: { items: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: /New shared config/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('Microsoft 365'), {
      target: { value: 'Microsoft 365' },
    })
    const keys = within(dialog).getAllByLabelText('Key')
    fireEvent.change(keys[0] as HTMLElement, { target: { value: 'm365_tenant_id' } })
    fireEvent.change(keys[1] as HTMLElement, { target: { value: 'M365_CLIENT_SECRET' } })
    // No team yet: the schema refuses and says so.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('Pick the team that owns it')).toBeInTheDocument()
    await within(dialog).findByRole('option', { name: 'IT Identity (Team)' })
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Owner team/ }), {
      target: { value: GROUP_ID },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/shared-resources')).toEqual({
        slug: 'microsoft-365',
        displayName: 'Microsoft 365',
        ownerGroupId: GROUP_ID,
        items: [
          { key: 'M365_TENANT_ID', kind: 'var' },
          { key: 'M365_CLIENT_SECRET', kind: 'secret' },
        ],
        policies: {},
      })
    )
    expect(await screen.findByRole('heading', { name: 'Microsoft 365', level: 1 })).toBeTruthy()
  })
})

describe('SharedResourcePage — the owner team', () => {
  it('says what is set, shows the vars to owners, and lists holders with a behind flag', async () => {
    renderPages(
      { [DETAIL]: ownerDetail(), [`${DETAIL}/pushes`]: { items: [] } },
      { route: `/shared-config/${RESOURCE_ID}` }
    )
    expect(await screen.findByTestId('value-line-staging')).toHaveTextContent(
      /^Set — version 3, rotated .* by Carol Checker$/
    )
    expect(screen.getAllByText('tenant-abc')).toHaveLength(2)
    const holders = screen.getByRole('table', { name: 'Holders' })
    const crm = within(holders).getByRole('link', { name: 'CRM' }).closest('tr') as HTMLElement
    expect(within(crm).getByText('behind')).toBeInTheDocument()
    expect(await screen.findByText('Nothing has been pushed yet.')).toBeInTheDocument()
  })

  it('the values modal is write-only: hidden, never pre-filled, and saving rotates', async () => {
    const fetchMock = renderPages(
      {
        [DETAIL]: ownerDetail(),
        [`${DETAIL}/pushes`]: { items: [] },
        [`PUT ${DETAIL}/values/production`]: () =>
          new Response(JSON.stringify({ versionId: VERSION_ID, version: 4, pushId: PUSH_ID }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
        [`${DETAIL}/pushes/${PUSH_ID}`]: push(),
      },
      { route: `/shared-config/${RESOURCE_ID}` }
    )
    const production = (await screen.findByTestId('value-line-production')).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(production).getByRole('button', { name: /Rotate/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/1 app holds it in production/)).toBeInTheDocument()
    // Every key is set: none has an input until Replace, and none is pre-filled after it.
    expect(within(dialog).getAllByText('Set — hidden')).toHaveLength(3)
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0)
    const secretRow = within(dialog).getByText('M365_CLIENT_SECRET').closest('li') as HTMLElement
    fireEvent.click(within(secretRow).getByRole('button', { name: 'Replace' }))
    const input = within(secretRow).getByLabelText('M365_CLIENT_SECRET') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: SENTINEL } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and push' }))

    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT ${DETAIL}/values/production`)).toEqual({
        values: { M365_CLIENT_SECRET: SENTINEL },
      })
    )
    // The push it started shows N/M on the environment, and the typed value is gone.
    expect(await screen.findByTestId('push-progress-label')).toHaveTextContent(
      '1 of 2 apps updated'
    )
    expect(document.body.innerHTML).not.toContain(SENTINEL)
  })

  it('a blank form is refused before any request', async () => {
    const fetchMock = renderPages(
      { [DETAIL]: ownerDetail(), [`${DETAIL}/pushes`]: { items: [] } },
      { route: `/shared-config/${RESOURCE_ID}` }
    )
    const staging = (await screen.findByTestId('value-line-staging')).closest(
      'section'
    ) as HTMLElement
    fireEvent.click(within(staging).getByRole('button', { name: /Rotate/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Save/ }))
    expect(await screen.findByText(/Type at least one value/)).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT')
    ).toBe(false)
  })

  it('a partial push lists the failed apps and retries them', async () => {
    const partial = push({
      status: 'partial',
      succeeded: 1,
      failed: 1,
      targets: [
        pushTarget('expenses'),
        pushTarget('crm', { status: 'failed', error: 'app_has_no_worker' }),
      ],
    })
    const fetchMock = renderPages(
      {
        [DETAIL]: ownerDetail(),
        [`${DETAIL}/pushes`]: { items: [pushSummary({ status: 'partial', failed: 1 })] },
        [`${DETAIL}/pushes/${PUSH_ID}`]: partial,
        [`POST ${DETAIL}/pushes/${PUSH_ID}/retry`]: () =>
          new Response(JSON.stringify(push({ status: 'running' })), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
      { route: `/shared-config/${RESOURCE_ID}` }
    )
    const row = await screen.findByRole('button', { name: /Rotation/ })
    fireEvent.click(row)
    const failed = await screen.findByRole('list', { name: 'Apps the push failed on' })
    expect(within(failed).getByText('CRM')).toBeInTheDocument()
    expect(within(failed).getByText(/app_has_no_worker/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Retry the failed apps/ }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith(`/pushes/${PUSH_ID}/retry`) && init?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('revokes one holder after confirming, on that holder’s app', async () => {
    const fetchMock = renderPages(
      {
        [DETAIL]: ownerDetail(),
        [`${DETAIL}/pushes`]: { items: [] },
        [`DELETE /api/apps/${APP_ID}/grants/${GRANT_ID}`]: {
          grant: {
            id: GRANT_ID,
            appId: APP_ID,
            resource: { id: RESOURCE_ID, slug: 'm365', displayName: 'Microsoft 365' },
            environment: 'production',
            status: 'revoking',
            approvalId: null,
            requestedByUserId: null,
            reason: null,
            expiresAt: null,
            pushedVersion: 3,
            pushedAt: null,
            pushError: null,
            revokedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          pushId: PUSH_ID,
        },
      },
      { route: `/shared-config/${RESOURCE_ID}` }
    )
    const holders = await screen.findByRole('table', { name: 'Holders' })
    const expenses = within(holders).getByRole('link', { name: 'Expenses' }).closest('tr')
    fireEvent.click(within(expenses as HTMLElement).getByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/removed from Expenses’s production Worker/)).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `DELETE /api/apps/${APP_ID}/grants/${GRANT_ID}`)).toEqual({})
    )
  })
})

describe('SharedResourcePage — a member', () => {
  it('sees names, status and policy — no holders, no vars, no Set — and never asks for pushes', async () => {
    const fetchMock = renderPages(
      { [DETAIL]: memberDetail() },
      { session: member(), route: `/shared-config/${RESOURCE_ID}` }
    )
    expect(await screen.findByText(/request it from the app’s Config page/)).toBeInTheDocument()
    expect(screen.getByText('M365_CLIENT_SECRET')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Holders' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rotate|Set values|Replace/ })).toBeNull()
    expect(screen.queryByText('tenant-abc')).not.toBeInTheDocument()
    // The default policy names the owner team, not "nobody".
    expect(screen.getAllByText('1 approval from the IT Identity team')).toHaveLength(2)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/pushes'))).toBe(false)
  })
})

describe('shared config model', () => {
  it('words a version and what is missing from it', () => {
    expect(valueLine({ version: null, setAt: null, setBy: null })).toBe('Not set')
    expect(
      valueLine({ version: 1, setAt: new Date(), setBy: { id: IDS.user, name: null, email: 'c@x.test' } })
    ).toMatch(/^Set — version 1, set .* by c@x\.test$/)
    expect(missingKeys([{ key: 'A' }, { key: 'B' }], { version: 2, keysSet: ['A'] })).toEqual(['B'])
    expect(missingKeys([{ key: 'A' }], { version: null, keysSet: [] })).toEqual([])
  })

  it('computes the bar and flags a holder that is behind', () => {
    expect(pushProgress({ status: 'running', total: 3, succeeded: 1, failed: 1 })).toEqual({
      value: 2,
      max: 3,
      label: '1 of 3 apps updated · 1 failed',
    })
    expect(pushProgress({ status: 'queued', total: 3, succeeded: 0, failed: 0 }).label).toBe(
      'Waiting to start'
    )
    const envs = [{ environment: 'production' as const, version: 4 }]
    expect(
      holderBehind({ status: 'active', pushedVersion: 3, environment: 'production' }, envs)
    ).toBe(true)
    expect(
      holderBehind({ status: 'active', pushedVersion: 4, environment: 'production' }, envs)
    ).toBe(false)
  })

  it('polls only while a push is queued or running', () => {
    expect(grantPushPollInterval('running')).toBe(3000)
    expect(grantPushPollInterval('queued')).toBe(3000)
    expect(grantPushPollInterval('partial')).toBe(false)
    expect(grantPushPollInterval(undefined)).toBe(false)
    expect(sharedResourcePollInterval({ activePushes: [] })).toBe(false)
  })
})
