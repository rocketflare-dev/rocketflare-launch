/**
 * The ways into and around coding sessions (Launch P3): the app page's `SessionsCard` — "Start
 * session" goes straight to the new session's page, a refusal is explained in place (never a
 * toast), the list links every row — and the operator's `/admin/sessions`, whose Drain and Undrain
 * both confirm first.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import { ApiError } from '@/ui/lib/api-client'
import SessionsAdmin from '@/ui/pages/admin/SessionsAdmin'
import { SessionsCard, startRefusal } from '@/ui/pages/apps/components/SessionsCard'
import {
  errorResponse,
  IDS,
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'
import { APP_ID, detailOf, SESSION_ID, summaryRow } from './helpers/sessions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

function renderCard(routes: Record<string, unknown>, canStart = true) {
  const fetchMock = stubFetch(routes)
  renderWithProviders(
    <Routes>
      <Route
        path="/apps/:slug"
        element={<SessionsCard appId={APP_ID} appSlug="expenses" canStart={canStart} />}
      />
      <Route path="/apps/:slug/sessions/:id" element={<p>session page</p>} />
    </Routes>,
    { session: makeSession(), route: '/apps/expenses' }
  )
  return fetchMock
}

describe('SessionsCard', () => {
  it('lists the app’s sessions with a link to each, and its PR', async () => {
    renderCard({
      [`/api/apps/${APP_ID}/sessions`]: {
        items: [
          summaryRow({ status: 'working', turnCount: 3 }),
          summaryRow({
            id: '5e551000-0000-4000-8000-000000000002',
            title: null,
            shortId: 'zyxwvutsrqpo',
            status: 'shipped',
            prNumber: 7,
            prUrl: 'https://github.com/acme/expenses/pull/7',
          }),
        ],
      },
    })
    const link = await screen.findByRole('link', { name: 'Friendlier home page' })
    expect(link).toHaveAttribute('href', `/apps/expenses/sessions/${SESSION_ID}`)
    expect(screen.getByRole('link', { name: 'Session zyxwvu' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /#7/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/expenses/pull/7'
    )
    expect(screen.getByText('Working')).toHaveAttribute('data-session-status', 'working')
  })

  it('names each session’s agent and model, since neither the agent nor its row changes', async () => {
    renderCard({
      [`/api/apps/${APP_ID}/sessions`]: {
        items: [
          summaryRow({ runtime: 'codex', model: 'gpt-6.1-sol' }),
          summaryRow({
            id: '5e551000-0000-4000-8000-000000000002',
            runtime: 'claude_code',
            model: 'claude-opus-5-5',
          }),
        ],
      },
    })
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1]).getByText('Codex')).toBeInTheDocument()
    expect(within(rows[1]).getByText('gpt-6.1-sol')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Claude Code')).toBeInTheDocument()
    expect(within(rows[2]).getByText('claude-opus-5-5')).toBeInTheDocument()
  })

  it('asks for finished sessions only when the toggle is on', async () => {
    const fetchMock = renderCard({ [`/api/apps/${APP_ID}/sessions`]: { items: [] } })
    expect(await screen.findByText('No sessions running')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show finished' }))
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument()
    const scopes = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://x').searchParams.get('scope'))
      .filter(Boolean)
    expect(scopes).toEqual(['active', 'all'])
  })

  it('starts a session and goes straight to its page', async () => {
    const fetchMock = renderCard({
      [`/api/apps/${APP_ID}/sessions`]: { items: [] },
      [`POST /api/apps/${APP_ID}/sessions`]: () =>
        new Response(JSON.stringify(detailOf({ status: 'requested', turnCount: 0 })), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Start session' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).endsWith(`/api/apps/${APP_ID}/sessions`) && i?.method === 'POST'
      )
    ).toBe(true)
  })

  it('explains a refusal in place, without a toast', async () => {
    renderCard({
      [`/api/apps/${APP_ID}/sessions`]: { items: [] },
      [`POST /api/apps/${APP_ID}/sessions`]: () =>
        errorResponse(409, 'Too many sessions', 'session_limit'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Start session' }))
    expect(await screen.findByText(/already has as many sessions running/)).toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('hides Start for someone who cannot start one', async () => {
    renderCard({ [`/api/apps/${APP_ID}/sessions`]: { items: [] } }, false)
    expect(await screen.findByText('No sessions running')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start session' })).not.toBeInTheDocument()
  })

  it('words every refusal code', () => {
    const refusal = (code: string) =>
      startRefusal(new ApiError({ error: 'x', statusCode: 409, code })).message
    expect(refusal('sessions_paused')).toMatch(/paused while Launch is being updated/)
    expect(refusal('session_budget_exhausted')).toMatch(/budget for the month/)
    expect(refusal('sessions_not_configured')).toMatch(/not set up on this deployment/)
    expect(startRefusal(new Error('boom')).tone).toBe('warning')
  })
})

describe('SessionsAdmin', () => {
  const adminRow = (overrides: Record<string, unknown> = {}) => ({
    ...summaryRow(overrides),
    appSlug: 'expenses',
    tenantId: IDS.tenant,
    imageVersion: 'session-0.1.0',
    containerSeconds: 3840,
  })

  function renderAdmin(routes: Record<string, unknown>) {
    const fetchMock = stubFetch(routes)
    renderWithProviders(<SessionsAdmin />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
      route: '/admin/sessions',
    })
    return fetchMock
  }

  it('lists live sessions across the deployment and drains after a confirm', async () => {
    let paused = false
    const fetchMock = renderAdmin({
      '/api/admin/sessions': () => ({ items: [adminRow({ status: 'working' })], paused }),
      'POST /api/admin/sessions/drain': () => {
        paused = true
        return { paused: true, suspended: 1 }
      },
    })
    const row = (await screen.findByRole('link', { name: 'Friendlier home page' })).closest('tr')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('1h 04m')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText('session-0.1.0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Drain sessions' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(/1 live session\(s\) will be asked to suspend/)
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drain' }))
    expect(await screen.findByText('Sessions are drained.')).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/drain') && i?.method === 'POST')
    ).toBe(true)
  })

  it('undrains from the paused banner, after a confirm', async () => {
    let paused = true
    renderAdmin({
      '/api/admin/sessions': () => ({ items: [], paused }),
      'POST /api/admin/sessions/undrain': () => {
        paused = false
        return { paused: false, suspended: 0 }
      },
    })
    expect(await screen.findByText('No live sessions')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Undrain/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undrain' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Drain sessions' })).toBeInTheDocument()
    )
  })
})
