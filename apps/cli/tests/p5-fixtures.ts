/**
 * Fixtures for the Launch P5 CLI tests: a shared resource (M365) as `/api/shared-resources` sends
 * it, a push with its targets, and an app's config view — wire shapes (ISO strings), so the
 * commands parse them with the real contracts.
 */
import { APP_ID, at } from './p4-fixtures'

export const RESOURCE_ID = '5e500000-0000-4000-8000-000000000001'
export const GROUP_ID = '96000000-0000-4000-8000-000000000001'
export const PUSH_ID = 'b0500000-0000-4000-8000-000000000001'
export const GRANT_ID = '9a000000-0000-4000-8000-000000000001'
export const GRANT_PROD_ID = '9b000000-0000-4000-8000-000000000002'
export const VERSION_ID = 'fe000000-0000-4000-8000-000000000001'
export const CRM_ID = 'c0000000-0000-4000-8000-000000000009'
/** Anything shaped like this must never appear in any output. */
export const SENTINEL = 'sEcReT-sentinel-7c1f'

export const items = [
  { key: 'M365_TENANT_ID', kind: 'var' },
  { key: 'M365_CLIENT_ID', kind: 'var' },
  { key: 'M365_CLIENT_SECRET', kind: 'secret', rotationDays: 90 },
]

export const env = (environment: string, over: Record<string, unknown> = {}) => ({
  environment,
  version: 3,
  versionId: VERSION_ID,
  setAt: at,
  setBy: { id: '11111111-1111-4111-8111-111111111111', name: 'Carol', email: 'carol@x.test' },
  keysSet: items.map(i => i.key),
  retiringVersions: [],
  rotationDue: [],
  holderCount: 2,
  ...over,
})

export const resource = (over: Record<string, unknown> = {}) => ({
  id: RESOURCE_ID,
  slug: 'm365',
  displayName: 'Microsoft 365',
  description: 'The company tenant',
  ownerGroup: { id: GROUP_ID, name: 'IT Identity' },
  items,
  environments: [env('staging'), env('production', { holderCount: 1 })],
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const resourceDetail = (over: Record<string, unknown> = {}) => ({
  ...resource(),
  policies: {},
  createdByUserId: null,
  activePushes: [],
  canManage: false,
  canSetValues: true,
  ...over,
})

export const pushSummary = (over: Record<string, unknown> = {}) => ({
  id: PUSH_ID,
  resourceId: RESOURCE_ID,
  environment: 'production',
  reason: 'rotate',
  grantId: null,
  versionId: VERSION_ID,
  version: 4,
  approvalId: null,
  status: 'running',
  total: 2,
  succeeded: 1,
  failed: 0,
  startedByUserId: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  ...over,
})

export const target = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `7a000000-0000-4000-8000-00000000000${slug === 'crm' ? 2 : 1}`,
  grantId: GRANT_ID,
  app: { id: slug === 'crm' ? CRM_ID : APP_ID, slug, displayName: slug },
  status: 'succeeded',
  attempts: 1,
  error: null,
  names: items.map(i => i.key),
  finishedAt: at,
  ...over,
})

export const push = (over: Record<string, unknown> = {}) => ({
  ...pushSummary(over),
  targets: [target('expenses'), target('crm', { status: 'pending', finishedAt: null })],
  ...over,
})

export const grant = (over: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  appId: APP_ID,
  resource: { id: RESOURCE_ID, slug: 'm365', displayName: 'Microsoft 365' },
  environment: 'staging',
  status: 'active',
  approvalId: null,
  requestedByUserId: null,
  reason: 'The connector',
  expiresAt: null,
  pushedVersion: 3,
  pushedAt: at,
  pushError: null,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const appConfig = (over: Record<string, unknown> = {}) => ({
  appId: APP_ID,
  scan: { ref: 'main', sha: 'abcdef1234567890', scannedAt: at, error: null },
  declared: [
    ...items.map(i => ({ key: i.key, secret: i.kind === 'secret', pluginId: 'm365-connector' })),
    { key: 'STRIPE_KEY', secret: true, pluginId: 'payments' },
  ],
  matched: [
    {
      resource: {
        id: RESOURCE_ID,
        slug: 'm365',
        displayName: 'Microsoft 365',
        items: items.map(({ key, kind }) => ({ key, kind })),
        archived: false,
      },
      keys: items.map(i => i.key),
      declaredBy: ['m365-connector'],
      grants: { staging: grant(), production: null },
    },
  ],
  needs: [],
  unmatched: ['STRIPE_KEY'],
  grants: [grant()],
  canRequest: true,
  ...over,
})
