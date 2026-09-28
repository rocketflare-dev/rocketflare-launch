/**
 * Shared config fixtures for the UI tests (Launch P5): rows shaped as `/api/shared-resources` and
 * `/api/apps/:id/config` send them (ISO strings — the hooks parse with the real contracts, so a
 * fixture cannot drift from `sharedResourceDetailSchema` / `appConfigSchema` without failing).
 */
import { IDS } from './renderWithProviders'

export const RESOURCE_ID = '5e500000-0000-4000-8000-000000000001'
export const GROUP_ID = '96000000-0000-4000-8000-000000000001'
export const PUSH_ID = 'b0500000-0000-4000-8000-000000000001'
export const GRANT_ID = '9a000000-0000-4000-8000-000000000001'
export const GRANT_PROD_ID = '9b000000-0000-4000-8000-000000000002'
export const VERSION_ID = 'fe000000-0000-4000-8000-000000000001'
export const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const CRM_ID = 'c0000000-0000-4000-8000-000000000009'
export const GRANT_APPROVAL_ID = 'a9900000-0000-4000-8000-000000000055'
/** Typed into a form in the tests; it must never be rendered back. */
export const SENTINEL = 'sEcReT-sentinel-7c1f'

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

export const ITEMS = [
  { key: 'M365_TENANT_ID', kind: 'var', description: 'The Entra tenant' },
  { key: 'M365_CLIENT_ID', kind: 'var' },
  { key: 'M365_CLIENT_SECRET', kind: 'secret', rotationDays: 90 },
]

export function envState(environment: string, overrides: Record<string, unknown> = {}) {
  return {
    environment,
    version: 3,
    versionId: VERSION_ID,
    setAt: iso(2 * 24 * 60),
    setBy: { id: IDS.otherUser, name: 'Carol Checker', email: 'carol@example.test' },
    keysSet: ITEMS.map(i => i.key),
    retiringVersions: [],
    rotationDue: [],
    holderCount: 2,
    ...overrides,
  }
}

export function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    slug: 'm365',
    displayName: 'Microsoft 365',
    description: 'The company tenant',
    ownerGroup: { id: GROUP_ID, name: 'IT Identity' },
    items: ITEMS,
    environments: [envState('staging'), envState('production', { holderCount: 1 })],
    archivedAt: null,
    createdAt: iso(600),
    updatedAt: iso(60),
    ...overrides,
  }
}

export function holder(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    grantId: slug === 'crm' ? GRANT_PROD_ID : GRANT_ID,
    app: {
      id: slug === 'crm' ? CRM_ID : APP_ID,
      slug,
      displayName: slug === 'crm' ? 'CRM' : 'Expenses',
    },
    environment: 'production',
    status: 'active',
    pushedVersion: 3,
    pushedAt: iso(30),
    pushError: null,
    expiresAt: null,
    ...overrides,
  }
}

/** The detail as the OWNER team sees it: var values and holders. */
export function ownerDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...resourceRow(),
    environments: [
      envState('staging', {
        vars: { M365_TENANT_ID: 'tenant-abc', M365_CLIENT_ID: 'client-123' },
      }),
      envState('production', {
        holderCount: 1,
        vars: { M365_TENANT_ID: 'tenant-abc', M365_CLIENT_ID: 'client-123' },
      }),
    ],
    policies: {},
    createdByUserId: null,
    holders: [holder('expenses'), holder('crm', { pushedVersion: 2, environment: 'production' })],
    activePushes: [],
    canManage: false,
    canSetValues: true,
    ...overrides,
  }
}

/** The detail as a member sees it: no holders, no var values. */
export function memberDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...resourceRow(),
    policies: {},
    createdByUserId: null,
    activePushes: [],
    canManage: false,
    canSetValues: false,
    ...overrides,
  }
}

export function pushSummary(overrides: Record<string, unknown> = {}) {
  return {
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
    startedByUserId: IDS.user,
    createdAt: iso(1),
    updatedAt: iso(0),
    finishedAt: null,
    ...overrides,
  }
}

export function pushTarget(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id:
      slug === 'crm'
        ? '7a000000-0000-4000-8000-000000000002'
        : '7a000000-0000-4000-8000-000000000001',
    grantId: slug === 'crm' ? GRANT_PROD_ID : GRANT_ID,
    app: {
      id: slug === 'crm' ? CRM_ID : APP_ID,
      slug,
      displayName: slug === 'crm' ? 'CRM' : 'Expenses',
    },
    status: 'succeeded',
    attempts: 1,
    error: null,
    names: ITEMS.map(i => i.key),
    finishedAt: iso(0),
    ...overrides,
  }
}

export function push(overrides: Record<string, unknown> = {}) {
  return {
    ...pushSummary(overrides),
    targets: [pushTarget('expenses'), pushTarget('crm', { status: 'pending', finishedAt: null })],
    ...overrides,
  }
}

export function appGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    appId: APP_ID,
    resource: { id: RESOURCE_ID, slug: 'm365', displayName: 'Microsoft 365' },
    environment: 'staging',
    status: 'active',
    approvalId: null,
    requestedByUserId: IDS.user,
    reason: 'The connector',
    expiresAt: null,
    pushedVersion: 3,
    pushedAt: iso(30),
    pushError: null,
    revokedAt: null,
    createdAt: iso(60),
    updatedAt: iso(30),
    ...overrides,
  }
}

export function appConfigView(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    scan: { ref: 'main', sha: 'abcdef1234567890', scannedAt: iso(120), error: null },
    declared: [
      ...ITEMS.map(i => ({ key: i.key, secret: i.kind === 'secret', pluginId: 'm365-connector' })),
      { key: 'STRIPE_KEY', secret: true, pluginId: 'payments' },
      { key: 'ANTHROPIC_API_KEY', secret: true, pluginId: 'kit' },
    ],
    matched: [
      {
        resource: {
          id: RESOURCE_ID,
          slug: 'm365',
          displayName: 'Microsoft 365',
          items: ITEMS.map(({ key, kind }) => ({ key, kind })),
          archived: false,
        },
        keys: ITEMS.map(i => i.key),
        declaredBy: ['m365-connector'],
        grants: { staging: appGrant(), production: null },
      },
    ],
    needs: [],
    unmatched: ['STRIPE_KEY', 'ANTHROPIC_API_KEY'],
    grants: [appGrant()],
    canRequest: true,
    ...overrides,
  }
}

export const grantRequestContext = (overrides: Record<string, unknown> = {}) => ({
  kind: 'grant.request',
  resourceId: RESOURCE_ID,
  resourceName: 'Microsoft 365',
  environment: 'production',
  items: ITEMS.map(({ key, kind }) => ({ key, kind })),
  declaredBy: ['m365-connector'],
  appSlug: 'expenses',
  expiresAt: null,
  ...overrides,
})
