/**
 * The approvals inbox and one request's page (Launch P4, spec/08, plan §4f). What they are
 * arranged to get right:
 *
 * - the inbox's boxes are URL tabs (`?box=`): Waiting on me (with the badge count), Requested by
 *   me, and All — for admins only; filters are URL params the list request carries; every row is
 *   a real link that says what is being approved in words;
 * - the request is a PAGE with the decision panel pinned above: focus on its heading (never on
 *   Approve), the comment validated and posted with the decision, N-of-M progress, the expiry;
 * - a 409 is information (`alert-info`, a refetch, no toast); a 403 turns into the same sentence
 *   the page shows somebody who may not decide; somebody who may not decide sees one sentence and
 *   no buttons;
 * - a production deploy shows its PRs with their CI, staging's health, and the release's chain;
 * - a settled request shows its outcome, including an approval still being carried out.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import ApprovalPage from '@/ui/pages/approvals/ApprovalPage'
import InboxPage from '@/ui/pages/approvals/InboxPage'
import {
  APP_ID,
  APPROVAL_ID,
  approvalDetail,
  approvalRow,
  auditRow,
  decision,
  RELEASE_ID,
} from './helpers/approvals'
import { grantRequestContext, memberDetail, RESOURCE_ID } from './helpers/grants'
import {
  errorResponse,
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

function renderInbox(routes: RouteTable, { session = makeSession(), route = '/approvals' } = {}) {
  const fetchMock = stubFetch({
    '/api/approvals/count': { count: 2 },
    '/api/groups': { items: [] },
    '/api/groups/mine': { items: [] },
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/approvals" element={<InboxPage />} />
      <Route path="/approvals/:id" element={<ApprovalPage />} />
    </Routes>,
    { session, route }
  )
  return fetchMock
}

describe('InboxPage', () => {
  it('opens on Waiting on me, with the count, and says what each request is in words', async () => {
    const fetchMock = renderInbox({ '/api/approvals': { items: [approvalRow()] } })
    const link = await screen.findByRole('link', { name: 'Deploy Expenses 1.3.0 to production' })
    expect(link).toHaveAttribute('href', `/approvals/${APPROVAL_ID}`)
    const tab = screen.getByRole('tab', { name: /Waiting on me/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(within(tab).getByText('2')).toBeInTheDocument()
    const row = link.closest('tr') as HTMLElement
    expect(within(row).getByText('Bob Builder')).toBeInTheDocument()
    expect(within(row).getByText('0 of 1 approval')).toBeInTheDocument()
    expect(within(row).getByText('Waiting')).toBeInTheDocument()
    expect(within(row).getByText(/expires in/)).toBeInTheDocument()
    const listCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('/api/approvals?')
    )
    expect(new URL(String(listCall?.[0]), 'http://x').searchParams.get('box')).toBe('mine')
  })

  it('offers All to an admin but not to a member, and filters by kind in the URL', async () => {
    const fetchMock = renderInbox({ '/api/approvals': { items: [] } }, { session: member() })
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'session.budget' } })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('kind=session.budget'))
      ).toBe(true)
    )
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument()
  })

  it('shows what I asked for, in any state, with a status filter', async () => {
    const fetchMock = renderInbox(
      {
        '/api/approvals': (_init: RequestInit | undefined, url: URL) =>
          url.searchParams.get('box') === 'requested'
            ? {
                items: [
                  approvalRow({
                    status: 'approved',
                    requestedByUserId: IDS.user,
                    decidedAt: new Date().toISOString(),
                  }),
                ],
              }
            : { items: [] },
      },
      { route: '/approvals?box=requested' }
    )
    const row = (await screen.findByRole('link', { name: /Deploy Expenses/ })).closest(
      'tr'
    ) as HTMLElement
    expect(within(row).getByText('You')).toBeInTheDocument()
    expect(within(row).getByText('Approved')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'rejected' } })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('status=rejected'))
      ).toBe(true)
    )
    fireEvent.click(screen.getByRole('tab', { name: 'All' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('box=all'))).toBe(true)
    )
  })
})

function renderRequest(routes: RouteTable, session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/groups': { items: [] },
    '/api/groups/mine': { items: [] },
    [`/api/apps/${APP_ID}/releases/${RELEASE_ID}/chain`]: {
      release: {
        id: RELEASE_ID,
        appId: APP_ID,
        version: '1.3.0',
        tag: '1.3.0',
        sha: 'c'.repeat(40),
        previousTag: '1.2.0',
        prs: [],
        status: 'awaiting_approval',
        createdByUserId: IDS.otherUser,
        approvalId: APPROVAL_ID,
        stagingTicketId: null,
        productionTicketId: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      events: [
        auditRow('pr.merged', { number: 41 }, 120),
        auditRow('release.created', { version: '1.3.0' }, 60),
        auditRow('deploy.activated', { environment: 'staging', version: '1.3.0' }, 40),
        auditRow('approval.requested', {}, 30),
      ],
    },
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/approvals/:id" element={<ApprovalPage />} />
    </Routes>,
    { session, route: `/approvals/${APPROVAL_ID}` }
  )
  return fetchMock
}

const BASE = `/api/approvals/${APPROVAL_ID}`

describe('ApprovalPage', () => {
  it('is a page: what, who, the panel focused on its HEADING, the PRs and the chain', async () => {
    renderRequest({ [BASE]: approvalDetail() })
    expect(
      await screen.findByRole('heading', { name: 'Deploy Expenses 1.3.0 to production' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Approvals' })).toHaveAttribute('href', '/approvals')

    const heading = screen.getByRole('heading', { name: 'Your decision' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('button', { name: /Approve production deploy/ })).not.toHaveFocus()
    expect(screen.getByText(/expires in 23 hours/)).toBeInTheDocument()

    expect(screen.getByText('The export fix is needed for month end.')).toBeInTheDocument()
    const prs = screen.getByRole('list', { name: 'Pull requests' })
    expect(within(prs).getByText('Friendlier home page')).toBeInTheDocument()
    expect(within(prs).getByText('CI failing')).toBeInTheDocument()
    expect(screen.getByText(/One pull request in this release had failing CI/)).toBeInTheDocument()

    const chain = await screen.findByRole('list', { name: 'Release chain' })
    const steps = within(chain)
      .getAllByRole('listitem')
      .map(li => li.getAttribute('data-action'))
    expect(steps).toEqual([
      'pr.merged',
      'release.created',
      'deploy.activated',
      'approval.requested',
    ])
    expect(within(chain).getByText('staging')).toBeInTheDocument()
  })

  it('approves with a comment, posting the shared schema, and shows the outcome', async () => {
    let decided = false
    const fetchMock = renderRequest({
      [BASE]: () =>
        decided
          ? approvalDetail({
              status: 'approved',
              approvals: 1,
              decidedAt: new Date().toISOString(),
              appliedAt: new Date().toISOString(),
              canDecide: false,
              whyNot: 'not_pending',
              decisions: [decision({ userId: IDS.user, comment: 'Ship it' })],
            })
          : approvalDetail(),
      [`POST ${BASE}/decide`]: () => {
        decided = true
        return approvalDetail({
          status: 'approved',
          approvals: 1,
          decidedAt: new Date().toISOString(),
          appliedAt: new Date().toISOString(),
          canDecide: false,
          whyNot: 'not_pending',
          decisions: [decision({ userId: IDS.user, comment: 'Ship it' })],
        })
      },
    })
    await screen.findByRole('heading', { name: 'Your decision' })
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /Approve production deploy/ }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${BASE}/decide`)).toEqual({
        decision: 'approve',
        comment: 'Ship it',
      })
    )
    expect(await screen.findByText(/and carried out/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your decision' })).not.toBeInTheDocument()
    const decisions = screen.getByRole('list', { name: 'Decisions' })
    expect(within(decisions).getByText('You')).toBeInTheDocument()
    expect(within(decisions).getByText('Ship it')).toBeInTheDocument()
  })

  it('treats a 409 as information — no toast, no red — and refetches', async () => {
    let calls = 0
    renderRequest({
      [BASE]: () => {
        calls += 1
        return approvalDetail()
      },
      [`POST ${BASE}/decide`]: errorResponse(409, 'Not pending', 'not_pending'),
    })
    await screen.findByRole('heading', { name: 'Your decision' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByText('Someone else got there first.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
    await waitFor(() => expect(calls).toBeGreaterThan(1))
  })

  it('shows somebody who may not decide one sentence and no buttons', async () => {
    renderRequest(
      {
        [BASE]: approvalDetail({
          canDecide: false,
          whyNot: 'self_approval',
          eligible: [{ id: crypto.randomUUID(), name: 'Bob Owner', email: 'bob@example.test' }],
        }),
      },
      member()
    )
    expect(
      await screen.findByRole('heading', { name: 'Waiting for a decision' })
    ).toBeInTheDocument()
    // The server names who it waits on (`eligible`), so the sentence does too.
    expect(
      screen.getByText(/can’t approve a request you asked for.*someone else has to: Bob Owner\./)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('turns a 403 at decide time into the same sentence', async () => {
    renderRequest({
      [BASE]: approvalDetail(),
      [`POST ${BASE}/decide`]: errorResponse(403, 'Not yours', 'not_an_approver'),
    })
    await screen.findByRole('heading', { name: 'Your decision' })
    fireEvent.click(screen.getByRole('button', { name: /Approve production deploy/ }))
    expect(
      await screen.findByText(
        'Waiting for the app’s owners or the organisation’s admins to decide.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
  })

  it('shows N-of-M progress and who has decided so far', async () => {
    renderRequest({
      [BASE]: approvalDetail({
        requiredApprovals: 2,
        approvals: 1,
        canDecide: false,
        whyNot: 'already_decided',
        decisions: [decision({ userId: IDS.user })],
      }),
    })
    expect(await screen.findByTestId('approval-progress')).toHaveTextContent('1 of 2 approvals')
    expect(screen.getByText(/already decided this request/)).toBeInTheDocument()
  })

  it('lets the requester withdraw, after a confirmation', async () => {
    const fetchMock = renderRequest({
      [BASE]: approvalDetail({ canDecide: false, whyNot: 'self_approval', canCancel: true }),
      [`POST ${BASE}/cancel`]: approvalDetail({ status: 'cancelled', canDecide: false }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(requestBody(fetchMock, `POST ${BASE}/cancel`)).toEqual({}))
  })

  it('names who a pending request waits on, and words an admin’s withdraw as an admin’s', async () => {
    renderRequest({
      [BASE]: approvalDetail({
        canCancel: true,
        eligible: [
          { id: crypto.randomUUID(), name: 'Bob Owner', email: 'bob@example.test' },
          { id: crypto.randomUUID(), name: null, email: 'ada@example.test' },
        ],
      }),
    })
    await screen.findByRole('heading', { name: 'Your decision' })
    expect(screen.getByText('Waiting on')).toBeInTheDocument()
    expect(screen.getByText('Bob Owner or ada@example.test')).toBeInTheDocument()
    // Somebody else asked (the fixture's requester is another user): not "changed your mind?".
    expect(screen.getByText(/As an admin you may withdraw this request/)).toBeInTheDocument()
    expect(screen.queryByText(/Changed your mind/)).not.toBeInTheDocument()
  })

  it('says when an approval is still being carried out, or failed to apply', async () => {
    renderRequest({
      [BASE]: approvalDetail({
        status: 'approved',
        decidedAt: new Date().toISOString(),
        applyError: 'GitHub answered 502',
        canDecide: false,
        whyNot: 'not_pending',
      }),
    })
    expect(await screen.findByText(/applying it failed/)).toBeInTheDocument()
    expect(screen.getByText('GitHub answered 502')).toBeInTheDocument()
  })

  it('renders an access request with the person’s own words, verbatim', async () => {
    renderRequest({
      [BASE]: approvalDetail({
        kind: 'app.access',
        subjectType: 'user',
        subjectId: IDS.otherUser,
        reason: null,
        context: { kind: 'app.access', userId: IDS.otherUser, message: 'I run payroll <b>now</b>' },
        policy: {
          approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
          minApprovals: 1,
          allowSelfApproval: false,
          expiresAfterMinutes: 14 * 24 * 60,
          autoApproveRole: null,
        },
      }),
    })
    expect(
      await screen.findByRole('heading', { name: 'Let Bob Builder sign in to Expenses' })
    ).toBeInTheDocument()
    expect(screen.getByText('I run payroll <b>now</b>')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Release chain' })).not.toBeInTheDocument()
  })

  it('renders a grant request: what the app would hold, never a value, decided by the owner team', async () => {
    renderRequest(
      {
        [BASE]: approvalDetail({
          kind: 'grant.request',
          subjectType: 'grant',
          subjectId: '9b000000-0000-4000-8000-000000000002',
          reason: 'The M365 connector reads the shared mailbox',
          context: grantRequestContext(),
          policy: {
            approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
            minApprovals: 1,
            allowSelfApproval: false,
            expiresAfterMinutes: 7 * 24 * 60,
            autoApproveRole: null,
          },
          canDecide: false,
          whyNot: 'not_an_approver',
          eligible: [
            { id: crypto.randomUUID(), name: 'Carol Checker', email: 'carol@example.test' },
          ],
        }),
        [`/api/shared-resources/${RESOURCE_ID}`]: memberDetail(),
      },
      member()
    )
    expect(
      await screen.findByRole('heading', {
        name: 'Let Expenses hold Microsoft 365 in production',
      })
    ).toBeInTheDocument()
    const items = screen.getByRole('list', { name: 'Items' })
    expect(within(items).getByText('M365_CLIENT_SECRET')).toBeInTheDocument()
    expect(within(items).getByText('secret')).toBeInTheDocument()
    expect(screen.getByText('m365-connector')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Microsoft 365' })).toHaveAttribute(
      'href',
      `/secrets/${RESOURCE_ID}`
    )
    // Who decides comes from the resource's owner group, not the (empty) policy lists.
    expect(await screen.findAllByText('the IT Identity team')).toHaveLength(2)
    expect(screen.queryByText(/nobody \(the policy names no approvers\)/)).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for Carol Checker to decide.')).toBeInTheDocument()
  })

  it('renders a session merge: the PR, its summary and diff stat, and the session to read (#5)', async () => {
    const sessionId = '5e551000-0000-4000-8000-000000000001'
    const prUrl = 'https://github.com/acme/expenses/pull/12'
    renderRequest({
      [BASE]: approvalDetail({
        kind: 'session.merge',
        subjectType: 'session',
        subjectId: sessionId,
        reason: null,
        context: {
          kind: 'session.merge',
          sessionId,
          shortId: 'abcdefghijkl',
          title: 'Friendlier home page',
          appSlug: 'expenses',
          prNumber: 12,
          prUrl,
          prTitle: 'Make the home page friendlier',
          summary: 'Changes the headline to “Welcome back”.\n\nNo data changes.',
          diffStat: ' src/ui/Home.tsx | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)',
          headSha: 'b'.repeat(40),
          sessionPath: `/sessions/${sessionId}`,
        },
        policy: {
          approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
          minApprovals: 1,
          allowSelfApproval: false,
          expiresAfterMinutes: 48 * 60,
          autoApproveRole: null,
        },
      }),
    })
    expect(
      await screen.findByRole('heading', {
        name: 'Merge “Make the home page friendlier” (#12) into Expenses and put it on staging',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Make the home page friendlier \(#12\)/ })
    ).toHaveAttribute('href', prUrl)
    // The session is a link an approver may follow — the app's session page, not the context's
    // bare `/sessions/<id>`, which is no route.
    expect(screen.getByRole('link', { name: 'Friendlier home page' })).toHaveAttribute(
      'href',
      `/apps/expenses/sessions/${sessionId}`
    )
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('Changes the headline to')
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('No data changes.')
    expect(screen.getByTestId('merge-diffstat')).toHaveTextContent('src/ui/Home.tsx | 4 ++--')
    expect(screen.getByText('bbbbbbb')).toBeInTheDocument()
    expect(screen.getByText(/Approving merges the pull request/)).toBeInTheDocument()
  })
})
