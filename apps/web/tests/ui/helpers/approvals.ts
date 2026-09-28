/**
 * Approval and release fixtures for the UI tests (Launch P4): rows shaped as the API sends them
 * (ISO strings — the hooks parse), built from the shared contracts' defaults so a fixture cannot
 * drift from `approvalDetailSchema` / `releaseSchema` without the parse in the hook failing.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { IDS } from './renderWithProviders'

export const APPROVAL_ID = 'a9900000-0000-4000-8000-000000000001'
export const RELEASE_ID = 'e1e1e1e1-0000-4000-8000-000000000001'
export const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

export const deployContext = (overrides: Record<string, unknown> = {}) => ({
  kind: 'deploy.production',
  environment: 'production',
  version: '1.3.0',
  tag: '1.3.0',
  sha: 'c'.repeat(40),
  ref: 'refs/tags/1.3.0',
  compareUrl: 'https://github.com/acme/expenses/compare/1.2.0...1.3.0',
  prs: [
    {
      number: 41,
      title: 'Friendlier home page',
      author: 'olive',
      mergedAt: iso(120),
      mergeSha: 'd'.repeat(40),
      url: 'https://github.com/acme/expenses/pull/41',
      sessionId: '5e551000-0000-4000-8000-000000000001',
      checks: 'passing',
    },
    {
      number: 42,
      title: 'Fix the export button',
      author: 'bob',
      mergedAt: iso(90),
      mergeSha: 'e'.repeat(40),
      url: null,
      checks: 'failing',
    },
  ],
  stagingHealth: 'up',
  stagingVersion: '1.3.0',
  ...overrides,
})

export function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    kind: 'deploy.production',
    status: 'pending',
    appId: APP_ID,
    app: { id: APP_ID, slug: 'expenses', displayName: 'Expenses' },
    subjectType: 'release',
    subjectId: RELEASE_ID,
    requestedByUserId: IDS.otherUser,
    requestedByLabel: null,
    requester: { id: IDS.otherUser, name: 'Bob Builder', email: 'bob@example.test' },
    reason: 'The export fix is needed for month end.',
    context: deployContext(),
    policy: DEFAULT_APPROVAL_POLICIES['deploy.production'],
    requiredApprovals: 1,
    approvals: 0,
    expiresAt: inMinutes(23 * 60),
    decidedAt: null,
    appliedAt: null,
    applyError: null,
    createdAt: iso(30),
    updatedAt: iso(30),
    ...overrides,
  }
}

export function approvalDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...approvalRow(),
    decisions: [],
    canDecide: true,
    whyNot: null,
    canCancel: false,
    ...overrides,
  }
}

export function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dec00000-0000-4000-8000-000000000001',
    requestId: APPROVAL_ID,
    userId: IDS.otherUser,
    userEmail: 'carol@example.test',
    userName: 'Carol Checker',
    decision: 'approve',
    comment: null,
    at: iso(5),
    ...overrides,
  }
}

export function releaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RELEASE_ID,
    appId: APP_ID,
    version: '1.3.0',
    tag: '1.3.0',
    sha: 'c'.repeat(40),
    previousTag: '1.2.0',
    prs: deployContext().prs.map(({ checks: _c, ...pr }) => pr),
    status: 'staging_active',
    createdByUserId: IDS.user,
    approvalId: null,
    stagingTicketId: null,
    productionTicketId: null,
    error: null,
    createdAt: iso(60),
    updatedAt: iso(20),
    ...overrides,
  }
}

let eventSeq = 0
export function auditRow(action: string, after: Record<string, unknown> = {}, minutesAgo = 10) {
  eventSeq += 1
  return {
    id: `e0000000-0000-4000-8000-${String(eventSeq).padStart(12, '0')}`,
    tenantId: IDS.tenant,
    at: iso(minutesAgo),
    actorType: 'user',
    actorUserId: IDS.user,
    actorEmail: 'owner@example.test',
    action,
    targetType: null,
    targetId: null,
    appId: APP_ID,
    summary: { after },
    requestId: null,
    approvalId: null,
    ip: null,
    userAgent: null,
  }
}
