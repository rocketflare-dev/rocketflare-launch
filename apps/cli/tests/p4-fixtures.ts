/** Fixtures for the Launch P4 CLI tests: an app, an approval request and its detail, a release. */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { TENANT_ID, TEST_KEY, tempStore } from './helpers'

export const SERVER = 'http://server.test'
export const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const APPROVAL_ID = 'a9900000-0000-4000-8000-000000000001'
export const RELEASE_ID = 'e1e00000-0000-4000-8000-000000000001'
export const ALICE = 'a11ce000-0000-4000-8000-000000000001'
export const BOB = 'b0b00000-0000-4000-8000-000000000002'
export const at = '2026-09-28T10:00:00.000Z'

export async function loggedInStore(cleanups: (() => Promise<void>)[]) {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t.store
}

export const appDetail = {
  id: APP_ID,
  slug: 'expenses',
  displayName: 'Expenses',
  description: null,
  status: 'live',
  source: 'imported',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: null,
  environments: [],
  createdAt: at,
  templateContractVersion: null,
  defaultBranch: 'main',
  updatedAt: at,
  viewerCanDeploy: true,
}

export const deployContext = {
  kind: 'deploy.production',
  environment: 'production',
  version: '1.4.0',
  tag: '1.4.0',
  sha: 'abcdef1234567890',
  ref: 'refs/tags/1.4.0',
  compareUrl: 'https://github.com/acme/expenses/compare/1.3.0...1.4.0',
  prs: [
    {
      number: 12,
      title: 'Blue button',
      author: 'alice',
      mergedAt: at,
      mergeSha: 'abc',
      checks: 'passing',
    },
  ],
  stagingHealth: 'up',
  stagingVersion: '1.4.0',
}

export const request = (over: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  kind: 'deploy.production',
  status: 'pending',
  appId: APP_ID,
  app: { id: APP_ID, slug: 'expenses', displayName: 'Expenses' },
  subjectType: 'release',
  subjectId: RELEASE_ID,
  requestedByUserId: ALICE,
  requestedByLabel: null,
  requester: { id: ALICE, name: 'Alice', email: 'alice@example.com' },
  reason: 'Ship the blue button',
  context: deployContext,
  policy: DEFAULT_APPROVAL_POLICIES['deploy.production'],
  requiredApprovals: 1,
  approvals: 0,
  expiresAt: '2026-09-29T10:00:00.000Z',
  decidedAt: null,
  appliedAt: null,
  applyError: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const detail = (over: Record<string, unknown> = {}) => ({
  ...request(over),
  decisions: [],
  canDecide: true,
  whyNot: null,
  canCancel: false,
  ...over,
})

export const release = (over: Record<string, unknown> = {}) => ({
  id: RELEASE_ID,
  appId: APP_ID,
  version: '1.4.0',
  tag: '1.4.0',
  sha: 'abcdef1234567890',
  previousTag: '1.3.0',
  prs: deployContext.prs.map(({ checks: _checks, ...pr }) => pr),
  status: 'staging_active',
  createdByUserId: ALICE,
  approvalId: null,
  stagingTicketId: null,
  productionTicketId: null,
  error: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})
