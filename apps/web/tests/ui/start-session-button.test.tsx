/**
 * The app page's two start buttons (§18.22) — the header's Build it and the Sessions tab's Start
 * session are one `StartSessionButton`: a plain button with one agent and nothing to choose; a
 * split button otherwise, whose caret ("Choose coding agent") lists each enabled agent with who
 * pays for it. Picking one starts the session on it and remembers it — per person, in
 * localStorage — for BOTH buttons; a remembered agent the deployment no longer offers falls back
 * to the server's default for the person (`defaultRuntime`), not to the first in the list.
 */
import type { AgentAccountsResponse, AgentRuntimeOption } from '@launch/shared/launch-agents'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppPage from '@/ui/pages/apps/AppPage'
import { agentChoiceStorageKey } from '@/ui/pages/apps/components/agentChoice'
import { IDS, makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'
import { APP_ID, detailOf } from './helpers/sessions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const STORAGE_KEY = agentChoiceStorageKey(IDS.user)
const POST_SESSIONS = `/api/apps/${APP_ID}/sessions`

const option = (overrides: Partial<AgentRuntimeOption> = {}): AgentRuntimeOption => ({
  runtime: 'claude_code',
  label: 'Claude Code',
  accountLabel: 'Claude subscription',
  enabled: true,
  credentialMode: 'platform',
  userCredentials: false,
  needsCode: true,
  ...overrides,
})
const codex = (overrides: Partial<AgentRuntimeOption> = {}) =>
  option({
    runtime: 'codex',
    label: 'Codex',
    accountLabel: 'ChatGPT plan',
    enabled: false,
    needsCode: false,
    ...overrides,
  })
const pi = (overrides: Partial<AgentRuntimeOption> = {}) =>
  option({ runtime: 'pi', label: 'Pi', accountLabel: null, needsCode: false, ...overrides })

const accounts = (overrides: Partial<AgentAccountsResponse> = {}): AgentAccountsResponse => ({
  runtimes: [option(), codex(), pi()],
  credentials: [],
  logins: [],
  defaultRuntime: 'claude_code',
  ...overrides,
})

/** A connected Claude subscription. */
const claudeCredential = {
  id: 'c0000000-0000-4000-8000-000000000001',
  runtime: 'claude_code' as const,
  kind: 'claude_oauth_token' as const,
  status: 'active' as const,
  metadata: {},
  expiresAt: null,
  lastUsedAt: null,
  inUse: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const app = () => ({
  id: APP_ID,
  slug: 'expenses',
  displayName: 'Expense Tracker',
  description: null,
  status: 'live',
  source: 'imported',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  templateContractVersion: '1',
  repoOwner: 'acme',
  repoName: 'expenses',
  defaultBranch: 'main',
  ownerGroup: null,
  environments: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  viewerCanDeploy: false,
})

/** Every POST body sent to start a session, in order. */
function startBodies(fetchMock: ReturnType<typeof stubFetch>): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init?.method ?? 'GET').toUpperCase() === 'POST' &&
        new URL(String(input), 'http://localhost').pathname === POST_SESSIONS
    )
    .map(([, init]) => JSON.parse(String(init?.body)))
}

function renderApp(
  agentAccounts: AgentAccountsResponse,
  { route = '/apps/expenses', hold = false } = {}
) {
  const fetchMock = stubFetch({
    '/api/apps/expenses': app(),
    [POST_SESSIONS]: { items: [] },
    '/api/me/agent-credentials': agentAccounts,
    // `hold`: the start never answers, so the page stays where it is.
    [`POST ${POST_SESSIONS}`]: () =>
      hold
        ? new Promise<Response>(() => {})
        : new Response(JSON.stringify(detailOf({ status: 'requested', turnCount: 0 })), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
  })
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/sessions/:id" element={<p>session page</p>} />
      <Route path="/apps/:slug/*" element={<AppPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

describe('Build it and Start session', () => {
  it('with one agent and nothing to choose: no caret, and Build it starts the P3 session', async () => {
    const fetchMock = renderApp(accounts({ runtimes: [option(), codex(), pi({ enabled: false })] }))
    const build = await screen.findByRole('button', { name: 'Build it' })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/me/agent-credentials'))
      ).toBe(true)
    )
    expect(screen.queryByLabelText('Choose coding agent')).not.toBeInTheDocument()
    fireEvent.click(build)
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(startBodies(fetchMock)).toEqual([{ warm: true }])
  })

  it('lists each enabled agent with who pays, and the main part names the current one', async () => {
    renderApp(
      accounts({
        runtimes: [
          option({ credentialMode: 'user_or_platform', userCredentials: true }),
          codex(),
          pi(),
        ],
        credentials: [claudeCredential],
      })
    )
    // The person connected their subscription: with either account allowed, theirs is the default.
    const build = await screen.findByRole('button', { name: 'Build it with Claude Code' })
    expect(build).toHaveClass('btn-flame')
    expect(build).toHaveAttribute('title', 'Claude Code — Billed to your Claude subscription')
    fireEvent.click(screen.getByLabelText('Choose coding agent'))
    const items = screen.getAllByRole('button', { name: / — / })
    expect(items.map(i => i.getAttribute('aria-label'))).toEqual([
      'Claude Code — Launch pays · Anthropic API',
      'Claude Code — Billed to your Claude subscription',
      'Pi — Launch pays · Workers AI',
    ])
    // Codex is off here: not offered.
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Claude Code — Billed to your Claude subscription' })
    ).toHaveAttribute('aria-current', 'true')
  })

  it('picking Pi starts a Pi session and remembers it; Build it then starts Pi in one click', async () => {
    const fetchMock = renderApp(accounts())
    expect(
      await screen.findByRole('button', { name: 'Build it with Claude Code' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Choose coding agent'))
    fireEvent.click(screen.getByRole('button', { name: 'Pi — Launch pays · Workers AI' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(startBodies(fetchMock)).toEqual([{ runtime: 'pi', warm: true }])
    expect(localStorage.getItem(STORAGE_KEY)).toBe('pi:platform')

    // Back on the app page later: one click on the main part starts Pi.
    cleanup()
    vi.unstubAllGlobals()
    const again = renderApp(accounts())
    fireEvent.click(await screen.findByRole('button', { name: 'Build it with Pi' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(startBodies(again)).toEqual([{ runtime: 'pi', warm: true }])
  })

  it('a remembered agent no longer on offer falls back to the server’s default, not the first', async () => {
    localStorage.setItem(STORAGE_KEY, 'codex:platform')
    const fetchMock = renderApp(accounts({ defaultRuntime: 'pi' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Build it with Pi' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(startBodies(fetchMock)).toEqual([{ runtime: 'pi', warm: true }])
  })

  it('the Sessions tab’s Start session is the same split button, and shares the choice', async () => {
    renderApp(accounts(), { route: '/apps/expenses/sessions', hold: true })
    expect(await screen.findByRole('heading', { name: 'Coding sessions' })).toBeInTheDocument()
    // No picker above the list: it read as a filter on it.
    expect(screen.queryByLabelText('Coding agent')).not.toBeInTheDocument()
    const start = await screen.findByRole('button', { name: 'Start session with Claude Code' })
    expect(start).not.toHaveClass('btn-flame')
    expect(screen.getByRole('button', { name: 'Build it with Claude Code' })).toBeInTheDocument()

    const panel = screen.getByRole('group', { name: 'Start session with Claude Code' })
    fireEvent.click(within(panel).getByLabelText('Choose coding agent'))
    fireEvent.click(within(panel).getByRole('button', { name: 'Pi — Launch pays · Workers AI' }))
    // The header's Build it follows at once: one remembered choice.
    expect(await screen.findByRole('button', { name: 'Build it with Pi' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start session with Pi' })).toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('pi:platform')
  })
})
