/**
 * Personal AI accounts in the UI (§18.22): Home's coding agents section is absent on a default
 * deployment, LEADS the page while nothing usable is connected (Connect starts a sign-in whose modal
 * relays the provider's URL out and the pasted code in), and drops to one quiet line once an
 * account is connected; the app's Sessions card's Start session splits into an agent menu ONLY
 * when there is a choice, and sends exactly the P3 request when there is not
 * (`start-session-button.test.tsx` has the menu itself); the session
 * header names a non-default agent or billing in one muted line. The pure decisions are tested
 * directly.
 */
import type {
  AgentAccountsResponse,
  AgentCredential,
  AgentLogin,
  AgentRuntimeOption,
} from '@launch/shared/launch-agents'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import {
  AGENT_LOGIN_IDLE_POLL_MS,
  AGENT_LOGIN_POLL_MS,
  agentLoginPollInterval,
} from '@/ui/hooks/useAgentAccounts'
import {
  agentOnboarding,
  connectableRuntimes,
  credentialStatusText,
} from '@/ui/pages/agent-accounts/agentAccountsModel'
import { startRequestFor } from '@/ui/pages/apps/components/agentChoice'
import { SessionsCard } from '@/ui/pages/apps/components/SessionsCard'
import Home from '@/ui/pages/Home'
import { sessionRuntimeLine } from '@/ui/pages/sessions/components/SessionHeader'
import {
  makeSession,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { APP_ID, detailOf } from './helpers/sessions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

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

const accounts = (overrides: Partial<AgentAccountsResponse> = {}): AgentAccountsResponse => ({
  runtimes: [option(), codex()],
  credentials: [],
  logins: [],
  defaultRuntime: 'claude_code',
  ...overrides,
})

const LOGIN_ID = '1091a000-0000-4000-8000-000000000001'
const login = (overrides: Partial<AgentLogin> = {}) => ({
  id: LOGIN_ID,
  runtime: 'claude_code',
  status: 'starting',
  verificationUrl: null,
  userCode: null,
  needsCode: true,
  error: null,
  expiresAt: '2030-01-01T00:00:00Z',
  createdAt: '2029-12-31T23:45:00Z',
  finishedAt: null,
  ...overrides,
})

describe('the pure decisions', () => {
  it('polls a login only while the server owes it an answer', () => {
    expect(agentLoginPollInterval(undefined)).toBe(false)
    expect(agentLoginPollInterval({ status: 'starting', needsCode: true })).toBe(
      AGENT_LOGIN_POLL_MS
    )
    // Claude waits for a paste in this tab: nothing to poll for.
    expect(agentLoginPollInterval({ status: 'awaiting_user', needsCode: true })).toBe(false)
    // Codex finishes at the provider: poll slowly.
    expect(agentLoginPollInterval({ status: 'awaiting_user', needsCode: false })).toBe(
      AGENT_LOGIN_IDLE_POLL_MS
    )
    expect(agentLoginPollInterval({ status: 'succeeded', needsCode: true })).toBe(false)
  })

  it('says what a credential is doing', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const base = {
      id: 'c',
      runtime: 'claude_code' as const,
      kind: 'claude_oauth_token' as const,
      status: 'active' as const,
      metadata: {},
      expiresAt: null,
      lastUsedAt: null,
      inUse: false,
      createdAt: now,
      updatedAt: now,
    }
    expect(credentialStatusText(undefined).text).toBe('Not connected')
    expect(credentialStatusText(base, now)).toEqual({ text: 'Connected', tone: 'muted' })
    expect(credentialStatusText({ ...base, status: 'needs_login' }, now).tone).toBe('warning')
    expect(
      credentialStatusText({ ...base, expiresAt: new Date('2026-01-10T00:00:00Z') }, now).text
    ).toMatch(/^Expires/)
    expect(connectableRuntimes([option(), option({ userCredentials: true })])).toHaveLength(1)
  })

  it('the start request is the P3 one unless there is a choice', () => {
    expect(startRequestFor(accounts(), { runtime: 'claude_code', credential: 'user' })).toEqual({})
    const either = accounts({
      runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true }), codex()],
    })
    expect(startRequestFor(either, { runtime: 'claude_code', credential: 'user' })).toEqual({
      runtime: 'claude_code',
      credential: 'user',
    })
    const two = accounts({ runtimes: [option(), codex({ enabled: true })] })
    expect(startRequestFor(two, { runtime: 'codex', credential: 'user' })).toEqual({
      runtime: 'codex',
    })
  })

  it('the header names only a non-default agent or billing', () => {
    expect(sessionRuntimeLine({ runtime: 'claude_code', credentialSource: 'platform' })).toBeNull()
    expect(sessionRuntimeLine({ runtime: 'codex', credentialSource: 'platform' })).toBe('Codex')
    expect(sessionRuntimeLine({ runtime: 'claude_code', credentialSource: 'user' })).toBe(
      'Claude Code · billed to the creator’s Claude subscription'
    )
  })
})

const credential = (overrides: Partial<AgentCredential> = {}): AgentCredential => ({
  id: 'c0000000-0000-4000-8000-000000000001',
  runtime: 'claude_code',
  kind: 'claude_oauth_token',
  status: 'active',
  metadata: {},
  expiresAt: null,
  lastUsedAt: null,
  inUse: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('Home: onboarding the decision', () => {
  const allowed = [
    option({ credentialMode: 'user', userCredentials: true }),
    codex({ enabled: true, credentialMode: 'user', userCredentials: true }),
  ]

  it('is hidden when no account may be connected, prominent until one works, quiet after', () => {
    expect(agentOnboarding(undefined).state).toBe('hidden')
    expect(agentOnboarding(accounts()).state).toBe('hidden')
    const none = agentOnboarding(accounts({ runtimes: allowed }))
    expect(none).toMatchObject({ state: 'connect', required: true })
    // A refused credential is not "connected": still prominent, with Reconnect.
    const refused = agentOnboarding(
      accounts({ runtimes: allowed, credentials: [credential({ status: 'needs_login' })] })
    )
    expect(refused.state).toBe('connect')
    expect(refused.state === 'connect' && refused.rows[0]?.reconnect).toBe(true)
    expect(
      agentOnboarding(accounts({ runtimes: allowed, credentials: [credential()] })).state
    ).toBe('connected')
    // With Launch's key as the alternative, connecting is encouraged but not required.
    const either = agentOnboarding(
      accounts({
        runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true })],
      })
    )
    expect(either).toMatchObject({ state: 'connect', required: false })
  })
})

describe('Home: coding agents section', () => {
  const homeRoutes = (agentAccounts: AgentAccountsResponse) => ({
    '/api/me/agent-credentials': agentAccounts,
    '/api/approvals/count': { count: 0 },
    '/api/approvals': { items: [] },
    '/api/apps': { items: [], appsDomain: 'apps.test' },
  })

  it('is absent on a default deployment', async () => {
    const fetchMock = stubFetch(homeRoutes(accounts()))
    renderWithProviders(<Home />, { session: makeSession() })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/me/agent-credentials'))
      ).toBe(true)
    )
    expect(screen.queryByText('Connect your coding agent')).not.toBeInTheDocument()
    expect(screen.queryByTestId('home-coding-agents-line')).not.toBeInTheDocument()
  })

  it('leads Home with both accounts to choose from while nothing is connected', async () => {
    stubFetch(
      homeRoutes(
        accounts({
          runtimes: [
            option({ credentialMode: 'user', userCredentials: true }),
            codex({ enabled: true, credentialMode: 'user', userCredentials: true }),
          ],
        })
      )
    )
    renderWithProviders(<Home />, { session: makeSession() })
    expect(
      await screen.findByRole('heading', { name: 'Connect your coding agent' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Connect one to start building/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Claude subscription' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect ChatGPT plan' })).toBeInTheDocument()
  })

  it('once one is connected it is one quiet line, offering the other', async () => {
    stubFetch(
      homeRoutes(
        accounts({
          runtimes: [
            option({ credentialMode: 'user', userCredentials: true }),
            codex({ enabled: true, credentialMode: 'user', userCredentials: true }),
          ],
          credentials: [credential()],
        })
      )
    )
    renderWithProviders(<Home />, { session: makeSession() })
    const line = await screen.findByTestId('home-coding-agents-line')
    expect(screen.queryByText('Connect your coding agent')).not.toBeInTheDocument()
    expect(line).toHaveTextContent('Claude subscription · Connected')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect your ChatGPT plan' })).toBeInTheDocument()
  })

  it('Connect starts a sign-in, shows the provider link, and pastes the code back', async () => {
    let current = login()
    const fetchMock = stubFetch({
      '/api/me/agent-credentials': accounts({
        runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true }), codex()],
      }),
      '/api/approvals/count': { count: 0 },
      '/api/approvals': { items: [] },
      '/api/apps': { items: [], appsDomain: 'apps.test' },
      'POST /api/me/agent-logins': () =>
        new Response(JSON.stringify({ login: current }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      [`/api/me/agent-logins/${LOGIN_ID}`]: () => ({ login: current }),
      [`POST /api/me/agent-logins/${LOGIN_ID}/code`]: () => {
        current = login({ status: 'submitting' })
        return new Response(JSON.stringify({ login: current }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await screen.findByText(/instead of the organisation’s key/)).toBeInTheDocument()

    // The Workflow puts the URL up while the modal polls.
    current = login({
      status: 'awaiting_user',
      verificationUrl: 'https://claude.ai/oauth/authorize?state=x',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude subscription' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/me/agent-logins')).toEqual({
        runtime: 'claude_code',
      })
    )
    const link = await screen.findByRole('link', { name: /Open Anthropic sign-in/ })
    expect(link).toHaveAttribute('href', 'https://claude.ai/oauth/authorize?state=x')
    expect(link).toHaveAttribute('target', '_blank')

    fireEvent.change(screen.getByLabelText(/Code from Anthropic/), {
      target: { value: 'abc-123#state-xyz' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/me/agent-logins/${LOGIN_ID}/code`)).toEqual({
        code: 'abc-123#state-xyz',
      })
    )
    expect(await screen.findByText('Sending your code…')).toBeInTheDocument()
  })
})

describe('SessionsCard and the agent menu', () => {
  function renderCard(agentAccounts: AgentAccountsResponse | null) {
    const fetchMock = stubFetch({
      [`/api/apps/${APP_ID}/sessions`]: { items: [] },
      ...(agentAccounts ? { '/api/me/agent-credentials': agentAccounts } : {}),
      [`POST /api/apps/${APP_ID}/sessions`]: () =>
        new Response(JSON.stringify(detailOf({ status: 'requested', turnCount: 0 })), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    renderWithProviders(
      <Routes>
        <Route
          path="/apps/:slug"
          element={<SessionsCard appId={APP_ID} appSlug="expenses" canStart />}
        />
        <Route path="/apps/:slug/sessions/:id" element={<p>session page</p>} />
      </Routes>,
      { session: makeSession(), route: '/apps/expenses' }
    )
    return fetchMock
  }

  it('with no choice to make there is no menu and Start sends the P3 request, warm', async () => {
    const fetchMock = renderCard(accounts())
    await screen.findByText('No sessions running')
    expect(screen.queryByLabelText('Choose coding agent')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/sessions`)).toEqual({ warm: true })
  })

  it('offers both accounts when either may pay, and sends the one picked', async () => {
    const fetchMock = renderCard(
      accounts({
        runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true }), codex()],
      })
    )
    fireEvent.click(await screen.findByLabelText('Choose coding agent'))
    // Not connected yet: the line says where to connect it.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Claude Code — Billed to your Claude subscription · connect it on Home first',
      })
    )
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/sessions`)).toEqual({
      runtime: 'claude_code',
      credential: 'user',
      warm: true,
    })
  })
})
