/**
 * The releases card on the app page (Launch P4, plan §1.8): the lifecycle per release, cutting one
 * (`POST {bump}` with the version previewed), promoting one staging runs (→ the approval it opened),
 * a 409 on promote shown as information, a link to a release's pending approval, and each row's
 * chain — read only when opened, in the order the server answered.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useParams } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import { ReleasesCard } from '@/ui/pages/apps/components/ReleasesCard'
import { APP_ID, APPROVAL_ID, auditRow, RELEASE_ID, releaseRow } from './helpers/approvals'
import {
  errorResponse,
  jsonResponse,
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

function ApprovalStub() {
  const { id } = useParams()
  return <p>approval page {id}</p>
}

const BASE = `/api/apps/${APP_ID}/releases`
const OLDER = 'e1e1e1e1-0000-4000-8000-000000000002'

function renderCard(routes: RouteTable, canRelease = true) {
  const fetchMock = stubFetch(routes)
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug" element={<ReleasesCard appId={APP_ID} canRelease={canRelease} />} />
      <Route path="/approvals/:id" element={<ApprovalStub />} />
    </Routes>,
    { session: makeSession(), route: '/apps/expenses' }
  )
  return fetchMock
}

describe('ReleasesCard', () => {
  it('lists releases with their place in the lifecycle, and links a pending approval', async () => {
    renderCard({
      [BASE]: {
        items: [
          releaseRow({ status: 'awaiting_approval', approvalId: APPROVAL_ID }),
          releaseRow({ id: OLDER, version: '1.2.0', tag: '1.2.0', status: 'production_active' }),
        ],
      },
    })
    const table = await screen.findByRole('table', { name: 'Releases' })
    expect(within(table).getByText('awaiting approval')).toBeInTheDocument()
    expect(within(table).getByText('in production')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: /Approval/ })).toHaveAttribute(
      'href',
      `/approvals/${APPROVAL_ID}`
    )
    expect(within(table).queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument()
  })

  it('cuts a release with the bump chosen, previewing the version', async () => {
    const fetchMock = renderCard({
      [BASE]: { items: [releaseRow({ status: 'production_active' })] },
      [`POST ${BASE}`]: () =>
        jsonResponse(releaseRow({ version: '1.4.0', tag: '1.4.0', status: 'tagged' }), 201),
    })
    fireEvent.click(await screen.findByRole('button', { name: /New release/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('1.3.1')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText(/minor/i))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release 1.4.0' }))
    await waitFor(() => expect(requestBody(fetchMock, `POST ${BASE}`)).toEqual({ bump: 'minor' }))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'Tagged 1.4.0 — staging deploys it next'
      )
    )
  })

  it('promotes a release staging runs, with a reason, and goes to the approval', async () => {
    const fetchMock = renderCard({
      [BASE]: { items: [releaseRow()] },
      [`POST ${BASE}/${RELEASE_ID}/promote`]: () =>
        jsonResponse(
          {
            release: releaseRow({ status: 'awaiting_approval', approvalId: APPROVAL_ID }),
            approvalId: APPROVAL_ID,
          },
          202
        ),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Promote/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/someone other than you approves it/)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText(/Why now/), {
      target: { value: 'Month end' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }))
    expect(await screen.findByText(`approval page ${APPROVAL_ID}`)).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST ${BASE}/${RELEASE_ID}/promote`)).toEqual({
      reason: 'Month end',
    })
  })

  it('shows a 409 on promote as information in the dialog, with no toast', async () => {
    renderCard({
      [BASE]: { items: [releaseRow()] },
      [`POST ${BASE}/${RELEASE_ID}/promote`]: errorResponse(
        409,
        'Staging is not running 1.3.0 any more',
        'release_not_on_staging'
      ),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Promote/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }))
    expect(
      await within(dialog).findByText('Staging is not running 1.3.0 any more')
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('offers neither New release nor Promote to someone who may not ship', async () => {
    renderCard({ [BASE]: { items: [releaseRow()] } }, false)
    await screen.findByRole('table', { name: 'Releases' })
    expect(screen.queryByRole('button', { name: /New release/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument()
  })

  it('reads a release’s chain only when it is opened, and renders it in order', async () => {
    const fetchMock = renderCard({
      [BASE]: { items: [releaseRow({ status: 'production_active' })] },
      [`${BASE}/${RELEASE_ID}/chain`]: {
        release: releaseRow({ status: 'production_active' }),
        events: [
          auditRow('session.shipped', { prNumber: 41 }, 200),
          auditRow('pr.merged', { number: 41 }, 120),
          auditRow('release.created', { version: '1.3.0' }, 60),
          auditRow('deploy.activated', { environment: 'staging' }, 50),
          auditRow('approval.requested', {}, 40),
          auditRow('approval.approved', {}, 30),
          auditRow('deploy.activated', { environment: 'production' }, 20),
          auditRow('release.production', { version: '1.3.0' }, 19),
        ],
      },
    })
    await screen.findByRole('table', { name: 'Releases' })
    const chainCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/chain')).length
    expect(chainCalls()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'History of 1.3.0' }))
    const chain = await screen.findByRole('list', { name: 'Release chain' })
    expect(
      within(chain)
        .getAllByRole('listitem')
        .map(li => li.getAttribute('data-action'))
    ).toEqual([
      'session.shipped',
      'pr.merged',
      'release.created',
      'deploy.activated',
      'approval.requested',
      'approval.approved',
      'deploy.activated',
      'release.production',
    ])
    expect(within(chain).getByText('Live in production')).toBeInTheDocument()
    expect(within(chain).getByText('production')).toBeInTheDocument()
    expect(chainCalls()).toBe(1)
  })
})
