/**
 * The coding-session page (Launch P3, spec/07): a PAGE with a breadcrumb back to the app, the chat
 * on the left and the live preview on the right. What it is arranged to get right:
 *
 * - the transcript is the DURABLE rows, topped up when the read-stream reports a `seq` past the
 *   cursor — tool calls as one-line rows (running ones spin), Claude's text as bubbles;
 * - the preview loads through a fresh grant, and reloads (with a fresh grant) after `turn.end`;
 * - Ship confirms, then the ship panel shows the gate attempts, the PR and its CI;
 * - over budget is a banner — with "Extend budget" for an owner or admin, "Ask for more budget" for
 *   its creator (a `session.budget` approval, P4, then a link to it), a sentence for anyone else;
 * - the composer: Enter sends (optimistically), Shift+Enter does not, a 409 is information and
 *   keeps the text, Stop cancels the running turn.
 */

import { DEFAULT_SESSION_POLICY } from '@launch/shared/launch-sessions'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useParams } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/ui/lib/query-keys'
import SessionPage from '@/ui/pages/sessions/SessionPage'
import { APPROVAL_ID, approvalDetail, approvalRow } from './helpers/approvals'
import {
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  notFoundResponse,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { detailOf, eventsRoute, SESSION_ID, sessionEvent, sseFrames } from './helpers/sessions'

function ApprovalStub() {
  const { id } = useParams()
  return <p>approval page {id}</p>
}

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
      <Route path="/approvals/:id" element={<ApprovalStub />} />
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

  it('frames the preview through a grant; a turn’s end leaves it to HMR, a dev server coming back reloads it', async () => {
    const log = [...DONE_TURN]
    let row = detailOf()
    const { queryClient, fetchMock } = renderPage({
      [BASE]: () => row,
      [`${BASE}/events`]: eventsRoute(log),
    })
    const grantCalls = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input).endsWith('/preview-grant') && init?.method === 'POST'
      )

    const frame = await screen.findByTitle('App preview')
    expect(frame.getAttribute('src')).toMatch(/__launch\/grant\?g=1$/)
    expect(screen.getByText('5173-abcdefghijkl-t0k3n00000.localhost:3001')).toBeInTheDocument()

    // The next turn ends: its edits already reached the frame by HMR, so no reload.
    log.push(
      sessionEvent(7, 'user.message', { text: 'Now make it blue', userId: IDS.user }, 2),
      sessionEvent(8, 'text', { text: 'Done — it is blue.' }, 2),
      sessionEvent(9, 'turn.end', { turn: 2, durationMs: 9000 }, 2)
    )
    row = detailOf({ turnCount: 2, updatedAt: '2026-09-28T10:05:00.000Z' })
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }))
    expect(await screen.findByText('Done — it is blue.')).toBeInTheDocument()
    expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=1$/)
    expect(grantCalls()).toHaveLength(1)

    // The dev server comes back up (a restart): the frame's HMR socket is dead, so it reloads.
    log.push(sessionEvent(10, 'preview.ready', { port: 5173 }, 2))
    row = detailOf({ turnCount: 2, updatedAt: '2026-09-28T10:06:00.000Z' })
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }))
    await waitFor(() =>
      expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=2$/)
    )
    expect(screen.getByText('Updated')).toBeInTheDocument()
    expect(grantCalls()).toHaveLength(2)
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
    expect(screen.getByText(/running lint, typecheck and the tests/)).toBeInTheDocument()
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
        // One row per step Launch ran (issue #1): attempt 1's tests failed, attempt 2 was green.
        sessionEvent(7, 'ship.gate', { step: 'lint', passed: true, attempt: 1 }, 2),
        sessionEvent(8, 'ship.gate', { step: 'typecheck', passed: true, attempt: 1 }, 2),
        sessionEvent(
          9,
          'ship.gate',
          {
            step: 'test',
            passed: false,
            attempt: 1,
            command: 'pnpm gate test',
            durationMs: 83_000,
            target:
              'test target: remote Neon branch gate-abcdefgh2345-1 (no Docker; the whole suite under neon)',
            output: '1 test failed',
          },
          2
        ),
        sessionEvent(10, 'ship.gate', { step: 'lint', passed: true, attempt: 2 }, 3),
        sessionEvent(11, 'ship.gate', { step: 'typecheck', passed: true, attempt: 2 }, 3),
        sessionEvent(12, 'ship.gate', { step: 'test', passed: true, attempt: 2 }, 3),
        sessionEvent(13, 'ship.pr', { number: 12, url: prUrl }, 3),
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
    const gates = within(screen.getByRole('list', { name: 'Checks before shipping' }))
    expect(gates.getByText('Attempt 1')).toBeInTheDocument()
    expect(gates.getByText('Attempt 2')).toBeInTheDocument()
    expect(gates.getAllByText('Lint passed')).toHaveLength(2)
    expect(gates.getByText('Tests failed')).toBeInTheDocument()
    expect(gates.getByText('pnpm gate test')).toBeInTheDocument()
    // Where the tests ran: the target line the kit's `pnpm test` printed.
    expect(
      gates.getByText(
        'test target: remote Neon branch gate-abcdefgh2345-1 (no Docker; the whole suite under neon)'
      )
    ).toBeInTheDocument()
    expect(gates.getByText('1 min 23 s')).toBeInTheDocument()
    expect(gates.getByText('1 test failed')).toBeInTheDocument()
    // …and the chat says each step as it happened.
    expect(screen.getByText('Tests failed on attempt 1.')).toBeInTheDocument()
    expect(screen.getByText('Tests passed (attempt 2).')).toBeInTheDocument()
    expect(screen.getByText('Opened pull request #12.')).toBeInTheDocument()
    // No sandbox any more: the preview pane says so and points at the PR.
    expect(
      screen.getByText('The sandbox is gone; the changes are in the pull request.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent(/was shipped/)
  })

  describe('after the PR: the landing, up to live on staging (#5)', () => {
    const prUrl = 'https://github.com/acme/expenses/pull/12'
    const APPROVAL = 'a9900000-0000-4000-8000-0000000000aa'
    const landing = (overrides: Record<string, unknown> = {}) => ({
      mode: 'staging',
      stage: 'ci',
      prNumber: 12,
      gateSha: 'b'.repeat(40),
      startedAt: '2026-09-28T10:10:00.000Z',
      stageAt: '2026-09-28T10:10:00.000Z',
      reviewMode: 'none',
      ...overrides,
    })
    const SHIPPED = [
      ...DONE_TURN,
      sessionEvent(7, 'ship.gate', { step: 'lint', passed: true, attempt: 1 }, 2),
      sessionEvent(8, 'ship.gate', { step: 'typecheck', passed: true, attempt: 1 }, 2),
      sessionEvent(9, 'ship.gate', { step: 'test', passed: true, attempt: 1 }, 2),
      sessionEvent(10, 'ship.pr', { number: 12, url: prUrl, title: 'Friendlier home page' }, 2),
    ]
    const ci = (state: string, extra: Record<string, unknown> = {}) => ({
      state,
      headSha: 'b'.repeat(40),
      passed: state === 'success' ? 2 : 1,
      failed: state === 'failure' ? 1 : 0,
      pending: state === 'pending' ? 1 : 0,
      ...extra,
    })
    const prRoute = {
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
            { name: 'Gate', source: 'check_run', state: 'pending', url: null },
            { name: 'lint', source: 'check_run', state: 'success', url: null },
          ],
        },
      },
    }
    /** The walk, step key → status, as the panel draws it. */
    const walk = () =>
      Object.fromEntries(
        within(screen.getByRole('list', { name: 'After the checks' }))
          .getAllByRole('listitem')
          .map(li => [li.getAttribute('data-landing-step'), li.getAttribute('data-step-status')])
      )

    it('walks gate → PR → CI while CI runs, with the round so far', async () => {
      renderPage({
        [BASE]: detailOf({ status: 'shipping', prNumber: 12, prUrl, landing: landing() }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('pending'), 2),
        ]),
        ...prRoute,
      })
      expect(await screen.findByRole('heading', { name: /Shipping/ })).toBeInTheDocument()
      await waitFor(() =>
        expect(walk()).toEqual({
          gate: 'done',
          pr: 'done',
          ci: 'active',
          merged: 'pending',
          released: 'pending',
          staging: 'pending',
        })
      )
      expect(screen.getByText('1 of 2 checks passed · 1 running')).toBeInTheDocument()
      expect(screen.getByText('Pull request #12 opened')).toBeInTheDocument()
      // The PR's own checks still list, by name, while CI is the stage.
      const list = await screen.findByRole('list', { name: 'CI checks' })
      expect(within(list).getByText('Gate')).toBeInTheDocument()
      expect(screen.queryByTestId('checks-summary')).not.toBeInTheDocument()
      expect(screen.getByTestId('composer-blocked')).toHaveTextContent('waiting for CI')
    })

    it('waits on a review, naming who it waits on and linking the request', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipping',
          prNumber: 12,
          prUrl,
          landing: landing({ stage: 'approval', reviewMode: 'app_owners', approvalId: APPROVAL }),
        }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('success'), 2),
          sessionEvent(12, 'ship.review', { status: 'requested', approvalId: APPROVAL }, 2),
        ]),
        [`/api/approvals/${APPROVAL}`]: approvalDetail({
          id: APPROVAL,
          kind: 'session.merge',
          subjectType: 'session',
          subjectId: SESSION_ID,
          canDecide: false,
          whyNot: 'self_approval',
          context: {
            kind: 'session.merge',
            sessionId: SESSION_ID,
            shortId: 'abcdefghijkl',
            title: 'Friendlier home page',
            appSlug: 'expenses',
            prNumber: 12,
            prUrl,
            prTitle: 'Friendlier home page',
            summary: 'Friendlier headline.',
            diffStat: '',
            headSha: 'b'.repeat(40),
            sessionPath: `/sessions/${SESSION_ID}`,
          },
          eligible: [{ id: IDS.otherUser, name: 'Bob Builder', email: 'bob@example.test' }],
        }),
      })
      await waitFor(() =>
        expect(screen.getByTestId('review-waiting')).toHaveTextContent('Waiting on Bob Builder.')
      )
      expect(walk()).toMatchObject({ ci: 'done', approval: 'active', merged: 'pending' })
      expect(screen.getByRole('link', { name: 'Open the request' })).toHaveAttribute(
        'href',
        `/approvals/${APPROVAL}`
      )
      expect(screen.getByText('Asked for a review before merging.')).toBeInTheDocument()
      expect(screen.getByTestId('composer-blocked')).toHaveTextContent('waiting for a review')
    })

    it('cannot be ended while it merges', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipping',
          prNumber: 12,
          prUrl,
          landing: landing({ stage: 'merging' }),
        }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('success'), 2),
        ]),
      })
      await waitFor(() => expect(walk()).toMatchObject({ ci: 'done', merged: 'active' }))
      expect(screen.getByText('Merging')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /End/ })).not.toBeInTheDocument()
    })

    it('follows the release to staging once merged', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing({
            stage: 'deploying',
            mergeSha: 'c'.repeat(40),
            mergedAt: '2026-09-28T10:20:00.000Z',
            version: '1.4.3',
            tag: '1.4.3',
          }),
        }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('success'), 2),
          sessionEvent(12, 'ship.merged', {
            number: 12,
            sha: 'c'.repeat(40),
            url: prUrl,
            approvalId: null,
          }),
          sessionEvent(13, 'ship.released', {
            releaseId: '7e1e0000-0000-4000-8000-000000000001',
            version: '1.4.3',
            tag: '1.4.3',
            shared: false,
          }),
          sessionEvent(14, 'ship.staging', { status: 'deploying', version: '1.4.3', url: null }),
        ]),
      })
      expect(await screen.findByRole('heading', { name: /Shipping/ })).toBeInTheDocument()
      await waitFor(() =>
        expect(walk()).toMatchObject({ merged: 'done', released: 'done', staging: 'active' })
      )
      expect(
        within(screen.getByRole('list', { name: 'After the checks' })).getByText('Released v1.4.3')
      ).toBeInTheDocument()
      expect(screen.getByText('Deploying to staging')).toBeInTheDocument()
      expect(screen.getByText('Merged pull request #12.')).toBeInTheDocument()
      expect(screen.getByTestId('composer-blocked')).toHaveTextContent('on its way to staging')
    })

    it('ends on “Live on staging: <link>, version X.Y.Z”', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing({
            stage: 'live',
            version: '1.4.3',
            tag: '1.4.3',
            stagingUrl: 'https://expenses-staging.apps.test',
          }),
        }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('success'), 2),
          sessionEvent(12, 'ship.staging', {
            status: 'live',
            version: '1.4.3',
            url: 'https://expenses-staging.apps.test',
          }),
        ]),
      })
      expect(await screen.findByRole('heading', { name: /Live on staging/ })).toBeInTheDocument()
      expect(screen.getByTestId('ship-live')).toHaveTextContent(
        'Live on staging: expenses-staging.apps.test, version v1.4.3'
      )
      expect(screen.getByRole('link', { name: 'expenses-staging.apps.test' })).toHaveAttribute(
        'href',
        'https://expenses-staging.apps.test'
      )
      await waitFor(() =>
        expect(Object.values(walk()).every(status => status === 'done')).toBe(true)
      )
      expect(screen.getByTestId('composer-blocked')).toHaveTextContent('live on staging')
    })

    it('reopens on red CI: the reason, the check, its log tail, and “Ask Claude to fix it”', async () => {
      const { fetchMock } = renderPage({
        // The landing is gone (null) once reopened; the rows carry the story.
        [BASE]: detailOf({ status: 'ready', prNumber: 12, prUrl, turnCount: 1 }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(
            11,
            'ship.ci',
            ci('failure', {
              failedCheck: {
                name: 'Gate',
                url: 'https://github.com/acme/expenses/actions/runs/9/job/1',
                logTail: 'FAIL tests/home.test.ts\n  expected "Welcome" to be "Welcome back"',
              },
            }),
            2
          ),
          sessionEvent(
            12,
            'ship.reopened',
            { reason: 'ci_failed', message: 'CI failed on the pull request.' },
            2
          ),
        ]),
        [`POST ${BASE}/turns`]: () => detailOf({ pendingMessage: true, prNumber: 12, prUrl }),
      })
      expect(await screen.findByRole('heading', { name: /Not shipped yet/ })).toBeInTheDocument()
      expect(screen.getByTestId('ship-reopened')).toHaveTextContent(
        'CI failed on the pull request, so Launch didn’t merge it.'
      )
      const failure = screen.getByTestId('ci-failure')
      expect(within(failure).getByRole('link', { name: 'Gate' })).toHaveAttribute(
        'href',
        'https://github.com/acme/expenses/actions/runs/9/job/1'
      )
      expect(
        within(failure).getByText(/expected "Welcome" to be "Welcome back"/)
      ).toBeInTheDocument()
      expect(walk()).toMatchObject({ pr: 'done', ci: 'failed', merged: 'pending' })
      // The chat says it too, and the session takes messages again.
      expect(screen.getByText('CI failed: Gate.')).toBeInTheDocument()
      expect(screen.getByLabelText('Message the coding agent')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /Ask Claude to fix it/ }))
      await waitFor(() => {
        const body = requestBody(fetchMock, `POST ${BASE}/turns`) as { message: string }
        expect(body.message).toMatch(/the check “Gate” is red/)
        expect(body.message).toContain('expected "Welcome" to be "Welcome back"')
      })
    })

    it('stalls after the merge: the reason, and the app page for what comes next', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing({
            stage: 'stalled',
            version: '1.4.3',
            stalledReason: 'deploy_failed',
            error: 'The staging deploy of 1.4.3 failed: wrangler exited 1.',
          }),
        }),
        [`${BASE}/events`]: eventsRoute([
          ...SHIPPED,
          sessionEvent(11, 'ship.ci', ci('success'), 2),
          sessionEvent(12, 'ship.staging', {
            status: 'failed',
            version: '1.4.3',
            url: null,
            error: 'The staging deploy of 1.4.3 failed: wrangler exited 1.',
          }),
        ]),
      })
      expect(
        await screen.findByRole('heading', { name: /Merged, not live yet/ })
      ).toBeInTheDocument()
      expect(screen.getByTestId('ship-stalled')).toHaveTextContent(
        'The change is merged and released, but the staging deploy failed.'
      )
      expect(screen.getAllByText(/wrangler exited 1/).length).toBeGreaterThan(0)
      expect(screen.getByRole('link', { name: 'the app’s page' })).toHaveAttribute(
        'href',
        '/apps/expenses'
      )
      expect(walk()).toMatchObject({ released: 'done', staging: 'failed' })
    })

    it('in `pr` mode ends at the open PR, as before', async () => {
      renderPage({
        [BASE]: detailOf({
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing({ mode: 'pr', stage: 'pr' }),
        }),
        [`${BASE}/events`]: eventsRoute(SHIPPED),
        ...prRoute,
      })
      expect(await screen.findByRole('heading', { name: /Shipped/ })).toBeInTheDocument()
      expect(screen.getByTestId('ship-pr-mode')).toHaveTextContent('open for review on GitHub')
      expect(screen.getByRole('link', { name: /Pull request #12/ })).toHaveAttribute('href', prUrl)
      expect(await screen.findByTestId('checks-summary')).toHaveTextContent(
        '1 of 2 checks passed · 1 running'
      )
      expect(screen.queryByRole('list', { name: 'After the checks' })).not.toBeInTheDocument()
    })
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

  it('takes an owner whose own session must wait (202) to the request it opened', async () => {
    renderPage({
      [BASE]: detailOf({ status: 'blocked' }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      '/api/approvals': { items: [] },
      [`POST ${BASE}/budget`]: () =>
        jsonResponse({ ...detailOf({ status: 'blocked' }), approvalId: APPROVAL_ID }, 202),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Extend budget' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Extend' }))
    expect(await screen.findByText(`approval page ${APPROVAL_ID}`)).toBeInTheDocument()
  })

  it('tells a reader over budget who can extend it, with no button', async () => {
    renderPage(
      {
        [BASE]: detailOf({ status: 'blocked', viewerCanManage: false }),
        [`${BASE}/events`]: eventsRoute(DONE_TURN),
      },
      member()
    )
    expect(
      await screen.findByText('Ask an owner of this app or an administrator to extend it.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Extend budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ask for more/ })).not.toBeInTheDocument()
  })

  it('lets its creator ask for more budget, with a reason, and goes to the request (P4)', async () => {
    const { fetchMock } = renderPage(
      {
        [BASE]: detailOf({ status: 'blocked' }),
        [`${BASE}/events`]: eventsRoute(DONE_TURN),
        '/api/approvals': { items: [] },
        [`POST ${BASE}/budget`]: () => ({
          ...detailOf({ status: 'blocked' }),
          approvalId: APPROVAL_ID,
        }),
      },
      member()
    )
    expect(
      await screen.findByText(
        'Ask an owner of this app or an administrator for more to keep going.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for more budget' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Ask for more budget')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '+$25' }))
    fireEvent.change(within(dialog).getByLabelText(/Why\?/), {
      target: { value: 'Two tests left to fix' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${BASE}/budget`)).toEqual({
        extraUsd: 25,
        reason: 'Two tests left to fix',
      })
    )
    expect(await screen.findByText(`approval page ${APPROVAL_ID}`)).toBeInTheDocument()
  })

  it('links the creator to their open budget request instead of asking twice', async () => {
    renderPage(
      {
        [BASE]: detailOf({ status: 'blocked' }),
        [`${BASE}/events`]: eventsRoute(DONE_TURN),
        '/api/approvals': (_init: RequestInit | undefined, url: URL) => {
          expect(url.searchParams.get('box')).toBe('requested')
          expect(url.searchParams.get('kind')).toBe('session.budget')
          return {
            items: [
              approvalRow({
                kind: 'session.budget',
                subjectType: 'session',
                subjectId: SESSION_ID,
                requestedByUserId: IDS.user,
                context: {
                  kind: 'session.budget',
                  sessionId: SESSION_ID,
                  sessionTitle: 'Friendlier home page',
                  extraUsd: 25,
                  spentUsd: 10,
                  capUsd: 10,
                },
              }),
            ],
          }
        },
      },
      member()
    )
    const link = await screen.findByRole('link', { name: 'See the request' })
    expect(link).toHaveAttribute('href', `/approvals/${APPROVAL_ID}`)
    expect(screen.getByRole('link', { name: 'Budget request pending' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ask for more budget' })).not.toBeInTheDocument()
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

  it('picks the next message’s model in the footer, and sends it only when it differs', async () => {
    const { fetchMock } = renderPage({
      [BASE]: detailOf(),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
      [`POST ${BASE}/turns`]: () => detailOf({ pendingMessage: true }),
    })
    const picker = await screen.findByLabelText('Model for the next message')
    expect(picker).toHaveValue('claude-sonnet-5')
    expect(
      within(picker)
        .getAllByRole('option')
        .map(o => o.textContent)
    ).toEqual(['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5'])
    fireEvent.change(picker, { target: { value: 'claude-opus-5-5' } })
    const box = screen.getByLabelText('Message the coding agent')
    fireEvent.change(box, { target: { value: 'Think it through' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${BASE}/turns`)).toEqual({
        message: 'Think it through',
        model: 'claude-opus-5-5',
      })
    )
  })

  it('keeps an older model the session runs on, and hides the picker when there is no choice', async () => {
    renderPage({
      [BASE]: detailOf({ policy: { ...DEFAULT_SESSION_POLICY, model: 'claude-sonnet-4-5' } }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
    })
    const picker = await screen.findByLabelText('Model for the next message')
    expect(picker).toHaveValue('claude-sonnet-4-5')
    expect(within(picker).getAllByRole('option')).toHaveLength(5)
    cleanup()
    renderPage({
      [BASE]: detailOf({
        runtime: 'codex',
        policy: { ...DEFAULT_SESSION_POLICY, model: 'gpt-6.1-sol' },
      }),
      [`${BASE}/events`]: eventsRoute(DONE_TURN),
    })
    await screen.findByLabelText('Message the coding agent')
    expect(screen.queryByLabelText('Model for the next message')).not.toBeInTheDocument()
  })

  it('says when a turn ran on a different model from the one before it', async () => {
    renderPage({
      [BASE]: detailOf({ turnCount: 2 }),
      [`${BASE}/events`]: eventsRoute([
        sessionEvent(1, 'user.message', { text: 'First', userId: IDS.user }),
        sessionEvent(2, 'turn.start', { turn: 1, model: 'claude-sonnet-5' }),
        sessionEvent(3, 'turn.end', { turn: 1 }),
        sessionEvent(4, 'user.message', { text: 'Second', userId: IDS.user }),
        sessionEvent(5, 'turn.start', { turn: 2, model: 'claude-sonnet-5' }),
        sessionEvent(6, 'turn.end', { turn: 2 }),
        sessionEvent(7, 'user.message', { text: 'Third', userId: IDS.user }),
        sessionEvent(8, 'turn.start', { turn: 3, model: 'claude-opus-5-5' }),
      ]),
    })
    expect(await screen.findByText('Switched to claude-opus-5-5')).toBeInTheDocument()
    expect(screen.getAllByText(/^Switched to/)).toHaveLength(1)
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
