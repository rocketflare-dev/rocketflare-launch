/**
 * The coding-session page (Launch P3, spec/07): a PAGE with a breadcrumb back to the app, the chat
 * on the left and the live preview on the right. What it is arranged to get right:
 *
 * - the transcript is the DURABLE rows, topped up when the read-stream reports a `seq` past the
 *   cursor — tool calls as one-line rows (running ones spin), Claude's text as bubbles;
 * - the preview loads through a fresh grant, and reloads (with a fresh grant) after `turn.end`;
 * - Ship confirms, then the ship panel shows the gate attempts, the PR and its CI;
 * - over budget is a banner — with "Extend budget" for an owner or admin, a sentence for anyone else;
 * - the composer: Enter sends (optimistically), Shift+Enter does not, a 409 is information and
 *   keeps the text, Stop cancels the running turn.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/ui/lib/query-keys'
import SessionPage from '@/ui/pages/sessions/SessionPage'
import {
  errorResponse,
  IDS,
  makeSession,
  notFoundResponse,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { detailOf, eventsRoute, SESSION_ID, sessionEvent, sseFrames } from './helpers/sessions'

const BASE = `/api/sessions/${SESSION_ID}`

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let grants = 0
const grantRoute = () => {
  grants += 1
  return {
    url: `http://5173-abcdefghijkl-t0k3n00000.localhost:3001/__launch/grant?g=${grants}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function renderPage(routes: RouteTable, session = makeSession()) {
  grants = 0
  const fetchMock = stubFetch({
    // The app detail is not needed for the page to work: the breadcrumb falls back to the slug.
    '/api/apps/expenses': notFoundResponse(),
    [`POST ${BASE}/preview-grant`]: grantRoute,
    [`${BASE}/agui/stream`]: () => sseFrames([], { hang: true }),
    ...routes,
  })
  const view = renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/sessions/:id" element={<SessionPage />} />
    </Routes>,
    { session, route: `/apps/expenses/sessions/${SESSION_ID}` }
  )
  return { fetchMock, ...view }
}

const DONE_TURN = [
  sessionEvent(1, 'user.message', { text: 'Make the headline friendlier', userId: IDS.user }),
  sessionEvent(2, 'turn.start', { turn: 1 }),
  sessionEvent(3, 'tool.start', {
    name: 'Edit',
    toolCallId: 't1',
    input: { file_path: 'src/ui/Home.tsx' },
  }),
  sessionEvent(4, 'tool.end', { name: 'Edit', toolCallId: 't1', result: 'ok' }),
  sessionEvent(5, 'text', { text: 'I changed the headline to **Welcome back**.' }),
  sessionEvent(6, 'turn.end', { turn: 1, durationMs: 42_000, costMicrocents: 12_000_000 }),
]

describe('SessionPage', () => {
  it('is a page: breadcrumb back to the app, status, cost against the cap, the transcript', async () => {
    renderPage({ [BASE]: detailOf(), [`${BASE}/events`]: eventsRoute(DONE_TURN) })
    expect(await screen.findByRole('heading', { name: 'Friendlier home page' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /expenses/ })).toHaveAttribute('href', '/apps/expenses')
    expect(screen.getByText('Ready')).toHaveAttribute('data-session-status', 'ready')
    expect(within(screen.getByTestId('session-cost')).getByText('$0.12')).toBeInTheDocument()
    expect(screen.getByText(/of \$10\.00/)).toBeInTheDocument()

    expect(await screen.findByText('Make the headline friendlier')).toBeInTheDocument()
    expect(screen.getByText('Welcome back')).toBeInTheDocument() // markdown, bold
    // The tool call is ONE line, in words.
    const tool = screen.getByText('Edited').closest('[data-event-kind="tool"]') as HTMLElement
    expect(within(tool).getByText('src/ui/Home.tsx')).toBeInTheDocument()
    expect(screen.getByText(/Turn 1 done · 42s · \$0\.12/)).toBeInTheDocument()
  })

  it('tops the transcript up when the stream reports rows past the cursor', async () => {
    const log = [
      sessionEvent(1, 'user.message', { text: 'Add a dark mode toggle', userId: IDS.user }),
      sessionEvent(2, 'turn.start', { turn: 1 }),
      sessionEvent(3, 'tool.start', {
        name: 'Edit',
        toolCallId: 't1',
        input: { file_path: 'src/ui/Header.tsx' },
      }),
      sessionEvent(4, 'tool.end', { name: 'Edit', toolCallId: 't1', result: 'ok' }),
      sessionEvent(5, 'text', { text: 'Added the toggle; now running the tests.' }),
      sessionEvent(6, 'tool.start', {
        name: 'Bash',
        toolCallId: 't2',
        input: { command: 'pnpm test' },
      }),
    ]
    let visible = 2
    let streams = 0
    renderPage({
      [BASE]: detailOf({ status: 'working', turnCount: 1 }),
      [`${BASE}/events`]: eventsRoute(log, () => visible),
      [`${BASE}/agui/stream`]: (_init: RequestInit | undefined, url: URL) => {
        streams += 1
        if (streams > 1) return sseFrames([], { hang: true })
        expect(url.searchParams.get('afterSeq')).toBe('2')
        visible = 6
        return sseFrames([
          { data: { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Edit' } },
          { data: { type: 'TOOL_CALL_END', toolCallId: 't1' }, id: 4 },
          { data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'x' }, id: 6 },
        ])
      },
    })

    expect(await screen.findByText('Add a dark mode toggle')).toBeInTheDocument()
    expect(await screen.findByText('Added the toggle; now running the tests.')).toBeInTheDocument()
    expect(screen.getByText('src/ui/Header.tsx')).toBeInTheDocument()
    // The running command spins; the turn is visibly in progress.
    const running = screen.getByText('pnpm test').closest('[data-event-kind="tool"]') as HTMLElement
    expect(within(running).getByRole('img', { name: 'running' })).toBeInTheDocument()
    expect(screen.getByTestId('turn-working')).toHaveTextContent('Working…')
    // Busy: the composer offers Stop, not Send.
    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBeInTheDocument()
  })

  it('frames the preview through a grant and reloads it with a fresh one after turn.end', async () => {
    const log = [...DONE_TURN]
    let row = detailOf()
    const { queryClient, fetchMock } = renderPage({
      [BASE]: () => row,
      [`${BASE}/events`]: eventsRoute(log),
    })

    const frame = await screen.findByTitle('App preview')
    expect(frame.getAttribute('src')).toMatch(/__launch\/grant\?g=1$/)
    expect(screen.getByText('5173-abcdefghijkl-t0k3n00000.localhost:3001')).toBeInTheDocument()

    // The next turn ends; the row moves and the nudge refreshes it.
    log.push(
      sessionEvent(7, 'user.message', { text: 'Now make it blue', userId: IDS.user }, 2),
      sessionEvent(8, 'text', { text: 'Done — it is blue.' }, 2),
      sessionEvent(9, 'turn.end', { turn: 2, durationMs: 9000 }, 2)
    )
    row = detailOf({ turnCount: 2, updatedAt: '2026-09-28T10:05:00.000Z' })
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }))

    await waitFor(() =>
      expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=2$/)
    )
    expect(screen.getByText('Done — it is blue.')).toBeInTheDocument()
    expect(screen.getByText('Updated')).toBeInTheDocument()
    const grantCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).endsWith('/preview-grant') && init?.method === 'POST'
    )
    expect(grantCalls).toHaveLength(2)
  })

  it('ships after a confirm, and shows the ship panel while it runs', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf(),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/ship`]: () => detailOf({ status: 'shipping' }),
    })
    fireEvent.click(await screen.findByRole('button', { name: /^Ship$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/opens a pull request/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ship' }))

    expect(await screen.findByRole('heading', { name: /Shipping/ })).toBeInTheDocument()
    expect(screen.getByText(/Running lint, typecheck and the tests/)).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/ship') && i?.method === 'POST')
    ).toBe(true)
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent(/Shipping/)
  })

  it('shows a shipped session: the gate attempts, the PR and its checks', async () => {
    const prUrl = 'https://github.com/acme/expenses/pull/12'
    renderPage({
      [BASE]: detailOf({ status: 'shipped', prNumber: 12, prUrl }),
      [`${BASE}/events`]: eventsRoute([
        ...DONE_TURN,
        sessionEvent(7, 'ship.gate', { passed: false, attempt: 1, output: '1 test failed' }, 2),
        sessionEvent(8, 'ship.gate', { passed: true, attempt: 2 }, 2),
        sessionEvent(9, 'ship.pr', { number: 12, url: prUrl }, 2),
      ]),
      [`${BASE}/pr`]: {
        prNumber: 12,
        prUrl,
        checks: {
          state: 'pending',
          headSha: 'b'.repeat(40),
          checkedAt: '2026-09-28T10:10:00Z',
          total: 2,
          passed: 1,
          failed: 0,
          pending: 1,
          checks: [
            { name: 'lint', source: 'check_run', state: 'success', url: null },
            { name: 'test', source: 'check_run', state: 'pending', url: null },
          ],
        },
      },
    })

    expect(await screen.findByRole('heading', { name: /Shipped/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Pull request #12/ })).toHaveAttribute('href', prUrl)
    expect(await screen.findByTestId('checks-summary')).toHaveTextContent(
      '1 of 2 checks passed · 1 running'
    )
    expect(screen.getByText('Attempt 1: something failed')).toBeInTheDocument()
    expect(screen.getByText('Attempt 2: lint, typecheck and tests passed')).toBeInTheDocument()
    expect(screen.getByText('1 test failed')).toBeInTheDocument()
    expect(screen.getByText('Opened pull request #12.')).toBeInTheDocument()
    // No sandbox any more: the preview pane says so and points at the PR.
    expect(
      screen.getByText('The sandbox is gone; the changes are in the pull request.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent(/was shipped/)
  })

  it('blocks on the budget: an owner can extend it, with the shared schema', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf({
        status: 'blocked',
        budget: {
          spentMicrocents: 1_000_000_000,
          capMicrocents: 1_000_000_000,
          extraMicrocents: 0,
        },
      }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/budget`]: () => detailOf({ status: 'ready' }),
    })
    expect(await screen.findByText('This session has used its $10.00 budget.')).toBeInTheDocument()
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('used its budget')
    fireEvent.click(screen.getByRole('button', { name: 'Extend budget' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '+$25' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Extend' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${BASE}/budget`)).toEqual({ extraUsd: 25 })
    )
  })

  it('tells a member over budget who can extend it, with no button', async () => {
    renderPage(
      {
        [BASE]: detailOf({ status: 'blocked' }),
        [`${BASE}/events`]: eventsRoute(DONE_TURN),
      },
      member()
    )
    expect(
      await screen.findByText('Ask an owner of this app or an administrator to extend it.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Extend budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Extend' })).not.toBeInTheDocument()
  })

  it('sends on Enter (not Shift+Enter) and shows the message at once', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf(),
      // The durable `user.message` row has not been written yet: only the optimistic bubble shows.
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/turns`]: () => detailOf({ pendingMessage: true }),
    })
    await screen.findByText('Make the headline friendlier')
    const box = screen.getByLabelText('Message the coding agent')
    fireEvent.change(box, { target: { value: 'Make the button blue' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(requestBody(fetchMock, `POST ${BASE}/turns`)).toBeUndefined()

    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${BASE}/turns`)).toEqual({
        message: 'Make the button blue',
      })
    )
    expect(box).toHaveValue('')
    expect(screen.getByText('Make the button blue')).toBeInTheDocument()
    expect(await screen.findByTestId('turn-working')).toHaveTextContent('Starting the turn…')
    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBeInTheDocument()
  })

  it('treats a 409 turn_in_progress as information and keeps the text', async () => {
    renderPage({
      [BASE]: detailOf(),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/turns`]: () => errorResponse(409, 'A turn is in progress', 'turn_in_progress'),
    })
    const box = await screen.findByLabelText('Message the coding agent')
    fireEvent.change(box, { target: { value: 'And the footer too' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/still working on the last message/)).toHaveAttribute(
      'role',
      'status'
    )
    expect(box).toHaveValue('And the footer too')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels the running turn with Stop', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf({ status: 'working' }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN.slice(0, 3)),
      [`POST ${BASE}/cancel`]: { cancelRequested: true },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this turn' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/cancel') && i?.method === 'POST')
      ).toBe(true)
    )
    expect(await screen.findByRole('button', { name: 'Stopping' })).toBeDisabled()
    expect(screen.getByTestId('turn-working')).toHaveTextContent('Stopping…')
  })

  it('offers Resume while asleep', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf({ status: 'suspended', suspendedAt: '2026-09-28T11:00:00Z' }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/resume`]: () =>
        detailOf({ status: 'booting', suspendedAt: '2026-09-28T11:00:00Z' }),
    })
    expect(await screen.findByText('This session is asleep')).toBeInTheDocument()
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('Resume it to keep going')
    fireEvent.click(screen.getByRole('button', { name: 'Resume session' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/resume') && i?.method === 'POST')
      ).toBe(true)
    )
    expect(await screen.findByText('Waking the session up')).toBeInTheDocument()
  })

  it('shows the boot steps of the current boot while starting', async () => {
    renderPage({
      [BASE]: detailOf({ status: 'booting', turnCount: 0 }),
      [`${BASE}/events`]: eventsRoute([
        sessionEvent(
          1,
          'step',
          { key: 'db', label: 'Branching the database', status: 'running' },
          0
        ),
        sessionEvent(2, 'step', { key: 'db', label: 'Branching the database', status: 'done' }, 0),
        sessionEvent(
          3,
          'step',
          { key: 'repo', label: 'Cloning the repository', status: 'running' },
          0
        ),
      ]),
    })
    expect(await screen.findByText('Starting your sandbox')).toBeInTheDocument()
    expect(await screen.findByText('Branching the database')).toBeInTheDocument()
    expect(screen.getByText('Cloning the repository')).toBeInTheDocument()
    // The empty transcript invites the first message even while booting.
    expect(screen.getByText(/Write your first message now/)).toBeInTheDocument()
  })

  it('renders a 404 as "No session here" with a way back', async () => {
    renderPage({ [BASE]: notFoundResponse() })
    expect(await screen.findByText('No session here')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the app' })).toHaveAttribute(
      'href',
      '/apps/expenses'
    )
  })
})
