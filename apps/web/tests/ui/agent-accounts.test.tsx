/**
 * Personal AI accounts in the UI (§18.22): the Profile panel is invisible on a default deployment,
 * lists the connectable accounts when one is allowed, and Connect starts a sign-in whose modal
 * relays the provider's URL out and the pasted code in; the app's Sessions card offers a picker
 * ONLY when there is a choice, and sends exactly the P3 request when there is not; the session
 * header names a non-default agent or billing in one muted line. The pure decisions are tested
 * directly.
 */
import type {
  AgentAccountsResponse,
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
import { SessionsCard, startRequestFor } from '@/ui/pages/apps/components/SessionsCard'
import {
  AgentAccountsPanel,
  connectableRuntimes,
  credentialStatusText,
} from '@/ui/pages/profile/AgentAccountsPanel'
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

describe('AgentAccountsPanel', () => {
  it('renders nothing on a default deployment', async () => {
    const fetchMock = stubFetch({ '/api/me/agent-credentials': accounts() })
    const { container } = renderWithProviders(<AgentAccountsPanel />, { session: makeSession() })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('Connect starts a sign-in, shows the provider link, and pastes the code back', async () => {
    let current = login()
    const fetchMock = stubFetch({
      '/api/me/agent-credentials': accounts({
        runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true }), codex()],
      }),
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
    renderWithProviders(<AgentAccountsPanel />, { session: makeSession() })
    expect(await screen.findByText('Claude subscription')).toBeInTheDocument()
    expect(screen.getByText(/Not connected/)).toBeInTheDocument()

    // The Workflow puts the URL up while the modal polls.
    current = login({
      status: 'awaiting_user',
      verificationUrl: 'https://claude.ai/oauth/authorize?state=x',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
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

describe('SessionsCard and the agent picker', () => {
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

  it('with no choice to make there is no picker and Start sends the P3 request', async () => {
    const fetchMock = renderCard(accounts())
    await screen.findByText('No sessions running')
    expect(screen.queryByText('Bill to')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/sessions`)).toEqual({})
  })

  it('offers "Bill to" when a personal account may be used, and sends the choice', async () => {
    const fetchMock = renderCard(
      accounts({
        runtimes: [option({ credentialMode: 'user_or_platform', userCredentials: true }), codex()],
        credentials: [
          {
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
          },
        ],
      })
    )
    const billTo = await screen.findByLabelText('Bill to')
    fireEvent.change(billTo, { target: { value: 'user' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(await screen.findByText('session page')).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/sessions`)).toEqual({
      runtime: 'claude_code',
      credential: 'user',
    })
  })
})
