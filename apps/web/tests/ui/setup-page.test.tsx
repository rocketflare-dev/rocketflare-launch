/**
 * Settings → Platform → Setup (spec/03): the stepper renders every step with the server's status, a set
 * credential is write-only ("Set — hidden" + Replace, never an input holding a value), Replace
 * opens an EMPTY field and PUTs only what was typed, and a bad settings value is refused with the
 * server's own schema message before any request.
 */
import {
  DEFAULT_TEMPLATE_PIN,
  type SetupCredential,
  type SetupOverview,
} from '@launch/shared/launch-setup'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CodingAgents from '@/ui/pages/platform/CodingAgents'
import Setup from '@/ui/pages/platform/Setup'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const unset = (kind: SetupCredential['kind']): SetupCredential => ({
  kind,
  set: false,
  setAt: null,
  setByUserId: null,
  setByEmail: null,
  rotatedAt: null,
  metadata: {},
  lastCheckStatus: null,
  lastCheck: null,
  lastCheckedAt: null,
})

const overview: SetupOverview = {
  steps: [
    { id: 'domain', status: 'ok' },
    { id: 'cloudflare', status: 'warning' },
    { id: 'neon', status: 'todo' },
    { id: 'resend', status: 'failed' },
    { id: 'github', status: 'todo' },
    { id: 'identity', status: 'ok' },
    { id: 'public_url', status: 'failed' },
  ],
  settings: {
    apps_domain: 'company-apps.test',
    cloudflare_account_id: '0123456789abcdef0123456789abcdef',
    neon_org_id: null,
    neon_region_id: null,
    notifications_domain: null,
    github_org: null,
  },
  effectiveNotificationsDomain: 'notifications.company-apps.test',
  credentials: [
    {
      ...unset('cloudflare_api_token'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      setByUserId: '11111111-1111-4111-8111-111111111111',
      setByEmail: 'ada@example.test',
      metadata: { accountId: '0123456789abcdef0123456789abcdef' },
      lastCheckStatus: 'warning',
      lastCheck: [
        { id: 'zone.account', label: 'Apps zone in this account', status: 'ok' },
        {
          id: 'token.write',
          label: 'Write permissions',
          status: 'warning',
          detail: 'Write scope unverified',
        },
      ],
      lastCheckedAt: new Date('2026-09-01T00:00:00Z'),
    },
    unset('neon_org_api_key'),
    {
      ...unset('resend_api_key'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckStatus: 'failed',
      lastCheck: [
        {
          id: 'domain.verified',
          label: 'Notifications domain verified',
          status: 'failed',
          detail: 'notifications.company-apps.test is not a Resend domain yet.',
        },
      ],
    },
    unset('github_app'),
  ],
  identity: {
    providers: ['google'],
    oidc: null,
    oidcOnly: false,
    checks: [{ id: 'providers', label: 'Single sign-on configured', status: 'ok' }],
  },
  publicUrl: {
    url: 'http://localhost:3000',
    status: 'failed',
    checks: [
      {
        id: 'url',
        label: 'Public URL',
        status: 'failed',
        detail: 'http://localhost:3000 is only reachable from this machine or network',
      },
    ],
    checkedAt: null,
  },
  templatePin: { pin: DEFAULT_TEMPLATE_PIN, isDefault: true, default: DEFAULT_TEMPLATE_PIN },
  sessionAgents: {
    runtimes: [
      {
        runtime: 'claude_code',
        label: 'Claude Code',
        accountLabel: 'Claude subscription',
        enabled: true,
        model: 'claude-sonnet-4-5',
        credentialMode: 'platform',
        isDefault: true,
        models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
        platformKey: { kind: 'anthropic_api_key', source: 'secret' },
        connectedAccounts: 0,
        minImage: null,
      },
      {
        runtime: 'codex',
        label: 'Codex',
        accountLabel: 'ChatGPT plan',
        enabled: false,
        model: 'gpt-6.1-sol',
        credentialMode: 'platform',
        isDefault: true,
        models: ['gpt-6.1-sol'],
        platformKey: { kind: 'openai_api_key', source: null },
        connectedAccounts: 2,
        minImage: 'session-6',
      },
    ],
  },
  sessionSandbox: {
    host: 'local',
    isDefault: true,
    options: [
      { host: 'local', label: "This Worker's containers", available: true, reason: null },
      {
        host: 'remote',
        label: 'Remote sandbox host',
        available: false,
        reason: 'pnpm dev could not use your Cloudflare account. Run wrangler login.',
      },
    ],
  },
}

const checkResponse = {
  credential: overview.credentials[0],
  status: 'warning',
  checks: overview.credentials[0]?.lastCheck ?? [],
}

function render(current: SetupOverview = overview, Page: () => JSX.Element = Setup) {
  const fetchMock = stubFetch({
    '/api/platform/setup': current,
    'PUT /api/platform/setup/template-pin': current,
    'DELETE /api/platform/setup/template-pin': current,
    '/api/platform/setup/template-pin/tags': {
      repo: 'rocketflare-dev/rocketflare',
      tags: [
        { name: '0.15.5', commit: 'c'.repeat(40) },
        { name: '0.15.4', commit: DEFAULT_TEMPLATE_PIN.commit },
      ],
    },
    'PUT /api/platform/setup/credentials/cloudflare_api_token': checkResponse,
    'PUT /api/platform/setup/credentials/openai_api_key': checkResponse,
    'PUT /api/platform/setup/settings': overview,
    'PUT /api/platform/setup/session-agents': current,
    'PUT /api/platform/setup/session-sandbox': current,
    'POST /api/platform/setup/public-url/check': {
      url: 'http://localhost:3000',
      status: 'failed',
      checks: overview.publicUrl.checks,
      checkedAt: '2026-09-28T00:00:00.000Z',
    },
  })
  renderWithProviders(<Page />, {
    session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
  })
  return fetchMock
}

describe('Admin → Setup', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the stepper and each step with its status', async () => {
    render()
    const nav = await screen.findByRole('navigation', { name: 'Setup steps' })
    for (const title of ['Domain & zone', 'Cloudflare', 'Neon', 'Resend', 'GitHub App']) {
      expect(within(nav).getByText(title)).toBeInTheDocument()
    }
    const resend = screen.getByRole('region', { name: /Resend/ })
    expect(resend.querySelector('header [data-status]')?.getAttribute('data-status')).toBe('failed')
    expect(within(resend).getByText(/is not a Resend domain yet/)).toBeInTheDocument()
    const cloudflare = screen.getByRole('region', { name: /2\.\s*Cloudflare/ })
    expect(within(cloudflare).getByText('Write permissions')).toBeInTheDocument()
    expect(within(cloudflare).getByText(/by ada@example.test/)).toBeInTheDocument()
  })

  it('shows the public URL step failing with why, and "Check now" probes it', async () => {
    const fetchMock = render()
    const card = await screen.findByRole('region', { name: /7\.\s*Public URL/ })
    expect(card.querySelector('header [data-status]')?.getAttribute('data-status')).toBe('failed')
    expect(within(card).getByText('http://localhost:3000')).toBeInTheDocument()
    expect(within(card).getByText(/only reachable from this machine/)).toBeInTheDocument()
    expect(within(card).getByText('Never')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith('/api/platform/setup/public-url/check') &&
            init?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('shows a set secret as hidden, and Replace opens an empty field that PUTs what was typed', async () => {
    const fetchMock = render()
    const cloudflare = await screen.findByRole('region', { name: /2\.\s*Cloudflare/ })
    expect(within(cloudflare).getByText(/Set — hidden/)).toBeInTheDocument()
    expect(cloudflare.querySelector('input[type="password"]')).toBeNull()

    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Replace' }))
    const input = within(cloudflare).getByLabelText('API token') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'new-cloudflare-token-0123456789' } })
    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Save and check' }))

    await waitFor(() =>
      expect(
        requestBody(fetchMock, 'PUT /api/platform/setup/credentials/cloudflare_api_token')
      ).toEqual({ apiToken: 'new-cloudflare-token-0123456789' })
    )
    // Settings did not change, so they were not sent.
    expect(requestBody(fetchMock, 'PUT /api/platform/setup/settings')).toBeUndefined()
  })

  it('the Setup tab no longer carries the coding agents or their keys', async () => {
    render({ ...overview, credentials: [...overview.credentials, unset('openai_api_key')] })
    await screen.findByRole('navigation', { name: 'Setup steps' })
    expect(screen.queryByRole('region', { name: 'Coding agents' })).toBeNull()
    expect(screen.queryByRole('region', { name: /OpenAI key/ })).toBeNull()
  })

  it('offers the Neon regions as a select, with a free-text fallback for any other id', async () => {
    const fetchMock = render()
    const neon = await screen.findByRole('region', { name: /3\.\s*Neon/ })
    const select = within(neon).getByLabelText('Region')
    expect(select.tagName).toBe('SELECT')
    expect(select).toHaveValue('')
    expect(
      within(select).getByRole('option', { name: /Frankfurt\) — aws-eu-central-1/ })
    ).toBeTruthy()

    fireEvent.change(select, { target: { value: 'aws-eu-central-1' } })
    fireEvent.click(within(neon).getByRole('button', { name: 'Save and check' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/settings')).toEqual({
        neon_region_id: 'aws-eu-central-1',
      })
    )
  })

  it('keeps a Neon region id the list does not know through "Other…"', async () => {
    const fetchMock = render()
    const neon = await screen.findByRole('region', { name: /3\.\s*Neon/ })
    const select = within(neon).getByLabelText('Region')
    fireEvent.change(select, { target: { value: '__other__' } })
    const other = within(neon).getByLabelText('Region (other)') as HTMLInputElement
    expect(other.value).toBe('')
    fireEvent.change(other, { target: { value: 'aws-ap-northeast-1' } })
    expect(select).toHaveValue('__other__')
    fireEvent.click(within(neon).getByRole('button', { name: 'Save and check' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/settings')).toEqual({
        neon_region_id: 'aws-ap-northeast-1',
      })
    )
  })

  it("refuses a bad setting with the server's own message, before any request", async () => {
    const fetchMock = render()
    const github = await screen.findByRole('region', { name: /GitHub App/ })
    fireEvent.change(within(github).getByLabelText('Organization'), {
      target: { value: 'not a valid org!' },
    })
    fireEvent.click(within(github).getByRole('button', { name: 'Save and check' }))
    expect(await within(github).findByText('A GitHub organization login')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/platform/setup/settings')).toBeUndefined()
  })
})

describe('Admin → Setup: the Kit version card', () => {
  afterEach(() => vi.unstubAllGlobals())

  const commitPinned: SetupOverview = {
    ...overview,
    templatePin: {
      pin: { repo: 'rocketflare-dev/rocketflare', commit: 'abcdef1'.padEnd(40, '0') },
      isDefault: false,
      default: DEFAULT_TEMPLATE_PIN,
    },
  }

  it('shows the default release pin: repo, tag and short SHA, and no reset or warning', async () => {
    render()
    const card = await screen.findByRole('region', { name: 'Kit version' })
    expect(within(card).getByText('Default')).toBeInTheDocument()
    expect(within(card).getByText('rocketflare-dev/rocketflare')).toBeInTheDocument()
    expect(within(card).getByText(`Release ${DEFAULT_TEMPLATE_PIN.tag}`)).toBeInTheDocument()
    expect(within(card).getByText(DEFAULT_TEMPLATE_PIN.commit.slice(0, 7))).toBeInTheDocument()
    expect(within(card).queryByText(/Unreleased commit — for development/)).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Reset to default' })).toBeNull()
  })

  it('pins a release tag the server resolves', async () => {
    const fetchMock = render()
    const card = await screen.findByRole('region', { name: 'Kit version' })
    fireEvent.change(within(card).getByLabelText('Release tag'), { target: { value: '0.15.5' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Pin tag' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/template-pin')).toEqual({
        kind: 'tag',
        tag: '0.15.5',
      })
    )
  })

  it('lists the repo’s tags on demand', async () => {
    const fetchMock = render()
    const card = await screen.findByRole('region', { name: 'Kit version' })
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/template-pin/tags'))
    ).toBe(false)
    fireEvent.click(within(card).getByRole('button', { name: 'List tags' }))
    expect(await within(card).findByText(/0\.15\.5, 0\.15\.4/)).toBeInTheDocument()
  })

  it('pins a commit — pasted, or the latest main — and refuses a malformed one before any request', async () => {
    const fetchMock = render()
    const card = await screen.findByRole('region', { name: 'Kit version' })
    fireEvent.click(within(card).getByLabelText('A commit (unreleased)'))

    fireEvent.change(within(card).getByLabelText('Commit SHA'), {
      target: { value: 'not a sha!' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Pin commit' }))
    expect(await within(card).findByText('A commit SHA or a branch name')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/platform/setup/template-pin')).toBeUndefined()

    fireEvent.click(within(card).getByRole('button', { name: 'Pin latest main' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/template-pin')).toEqual({
        kind: 'commit',
        ref: 'main',
      })
    )
  })

  it('warns that a commit pin is for development, and resets to the default', async () => {
    const fetchMock = render(commitPinned)
    const card = await screen.findByRole('region', { name: 'Kit version' })
    expect(within(card).getByText('Overridden')).toBeInTheDocument()
    expect(within(card).getByText('Unreleased commit')).toBeInTheDocument()
    expect(within(card).getByText('abcdef1')).toBeInTheDocument()
    expect(within(card).getByText(/Unreleased commit — for development/)).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Reset to default' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith('/api/platform/setup/template-pin') && init?.method === 'DELETE'
        )
      ).toBe(true)
    )
  })
})

describe('Admin → Coding agents tab', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows each agent with its switch, model and who pays, plus readiness', async () => {
    render(overview, CodingAgents)
    const card = await screen.findByRole('region', { name: 'Coding agents' })
    expect(within(card).getByText(/Changes apply to new sessions/)).toBeInTheDocument()
    expect(within(card).getByLabelText('Claude Code')).toBeChecked()
    expect(within(card).getByLabelText('Codex')).not.toBeChecked()
    expect(card.querySelector('#coding-agent-claude_code-model')).toHaveValue('claude-sonnet-4-5')
    expect(card.querySelector('#coding-agent-claude_code-pays')).toHaveValue('platform')
    expect(within(card).getByText('Ready')).toBeInTheDocument()
    expect(within(card).getByText(/ANTHROPIC_API_KEY secret/)).toBeInTheDocument()
    expect(within(card).getByText('Off')).toBeInTheDocument()
    expect(within(card).getByText(/2 people have connected a ChatGPT plan/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('turning Codex on and saving sends every agent', async () => {
    const fetchMock = render(overview, CodingAgents)
    const card = await screen.findByRole('region', { name: 'Coding agents' })
    fireEvent.click(within(card).getByLabelText('Codex'))
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/session-agents')).toEqual({
        runtimes: {
          claude_code: { enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
          codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' },
        },
      })
    )
  })

  it('allowing personal accounts asks first, with the vendor terms; cancelling keeps Launch', async () => {
    const fetchMock = render(overview, CodingAgents)
    const card = await screen.findByRole('region', { name: 'Coding agents' })
    const [pays] = within(card).getAllByLabelText('Who pays')
    if (!pays) throw new Error('no Who pays select')
    fireEvent.change(pays, { target: { value: 'user_or_platform' } })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Anthropic's terms restrict storing/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(pays).toHaveValue('platform')

    fireEvent.change(pays, { target: { value: 'user' } })
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Accept and allow' })
    )
    expect(pays).toHaveValue('user')
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(
        (
          requestBody(fetchMock, 'PUT /api/platform/setup/session-agents') as
            | { runtimes: Record<string, unknown> }
            | undefined
        )?.runtimes.claude_code
      ).toEqual({ enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'user' })
    )
  })

  it('will not save with every agent off', async () => {
    const fetchMock = render(overview, CodingAgents)
    const card = await screen.findByRole('region', { name: 'Coding agents' })
    fireEvent.click(within(card).getByLabelText('Claude Code'))
    expect(within(card).getByText(/Keep at least one agent on/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(requestBody(fetchMock, 'PUT /api/platform/setup/session-agents')).toBeUndefined()
  })

  it('an agent turned on without a key says so and links to the key card', async () => {
    render(overview, CodingAgents)
    const card = await screen.findByRole('region', { name: 'Coding agents' })
    fireEvent.click(within(card).getByLabelText('Codex'))
    expect(within(card).getByText(/Needs an OpenAI key/)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Set it' })).toHaveAttribute(
      'href',
      '#setup-openai'
    )
  })

  it('the OpenAI key card sits under the agents and saves what was typed', async () => {
    const fetchMock = render(
      { ...overview, credentials: [...overview.credentials, unset('openai_api_key')] },
      CodingAgents
    )
    const card = await screen.findByRole('region', { name: /OpenAI key/ })
    expect(card.querySelector('header [data-status]')?.getAttribute('data-status')).toBe('todo')
    // Built, not written out: a literal key-shaped string in a test is what secret scanners look for.
    const key = ['sk', 'proj', 'typed-into-the-setup-card-000000'].join('-')
    fireEvent.change(within(card).getByLabelText('API key'), { target: { value: key } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save and check' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/credentials/openai_api_key')).toEqual({
        apiKey: key,
      })
    )
  })

  it('a server that reports no OpenAI credential shows no OpenAI card', async () => {
    render(overview, CodingAgents)
    await screen.findByRole('region', { name: 'Coding agents' })
    expect(screen.queryByRole('region', { name: /OpenAI/ })).toBeNull()
  })
})

describe('Admin → Coding agents tab: the Session sandbox section', () => {
  afterEach(() => vi.unstubAllGlobals())

  const bothAvailable: SetupOverview = {
    ...overview,
    sessionSandbox: {
      host: 'local',
      isDefault: true,
      options: [
        { host: 'local', label: "This Worker's containers", available: true, reason: null },
        { host: 'remote', label: 'Remote sandbox host', available: true, reason: null },
      ],
    },
  }

  it('shows both hosts, the current one chosen, and disables an unavailable one with its reason', async () => {
    render(overview, CodingAgents)
    const section = await screen.findByRole('region', { name: 'Session sandbox' })
    expect(within(section).getByLabelText("This Worker's containers")).toBeChecked()
    const remote = within(section).getByLabelText('Remote sandbox host')
    expect(remote).toBeDisabled()
    expect(within(section).getByText(/Run wrangler login/)).toBeInTheDocument()
    expect(within(section).getByText(/Applies to new sessions/)).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('choosing the remote host and saving sends it', async () => {
    const fetchMock = render(bothAvailable, CodingAgents)
    const section = await screen.findByRole('region', { name: 'Session sandbox' })
    fireEvent.click(within(section).getByLabelText('Remote sandbox host'))
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/platform/setup/session-sandbox')).toEqual({
        host: 'remote',
      })
    )
  })

  it('a chosen host that is no longer available says new sessions cannot start', async () => {
    render(
      {
        ...overview,
        sessionSandbox: {
          host: 'remote',
          isDefault: false,
          options: overview.sessionSandbox.options,
        },
      },
      CodingAgents
    )
    const section = await screen.findByRole('region', { name: 'Session sandbox' })
    expect(within(section).getByText(/New sessions cannot start/)).toBeInTheDocument()
  })

  it('deployed, only this Worker’s containers are offered', async () => {
    render(
      {
        ...overview,
        sessionSandbox: {
          host: 'local',
          isDefault: true,
          options: [
            { host: 'local', label: "This Worker's containers", available: true, reason: null },
          ],
        },
      },
      CodingAgents
    )
    const section = await screen.findByRole('region', { name: 'Session sandbox' })
    expect(within(section).queryByLabelText('Remote sandbox host')).toBeNull()
  })
})
