/**
 * An in-memory platform credential store, for suites that drive Launch code which reads
 * `admin_credentials` / `launch_settings` (the create-an-app pipeline, `/ci/scaffold`,
 * `/ci/deploy`, `POST /api/apps`). Neither table has a tenant: writing them from a suite that runs
 * beside `tests/api/setup.test.ts` (which owns them) would race it. So such a suite MOCKS the one
 * module that reads them, `@/api/services/launch/credentials`, over a hoisted store:
 *
 * ```ts
 * // @vitest-isolate
 * const store = vi.hoisted(() => ({ credentials: new Map(), settings: new Map() }))
 * vi.mock('@/api/services/launch/credentials', async importOriginal =>
 *   (await import('../helpers/credential-store')).mockCredentialsModule(
 *     await importOriginal(),
 *     store
 *   )
 * )
 * ```
 *
 * Every reader and writer of the module then works against `store` — `putCredential` and
 * `putSetting` included, so a test seeds exactly as Setup would, through the real signatures.
 * Values are kept unsealed (there is nothing to protect in memory); the payload is still parsed
 * by the real `credentialPayloadSchemas`, so a malformed seed fails as it would in Setup.
 */

import { isDeepStrictEqual } from 'node:util'
import {
  CREDENTIAL_KINDS,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialStatus,
  credentialPayloadSchemas,
} from '@launch/shared/launch-setup'
import type * as Credentials from '@/api/services/launch/credentials'

export interface CredentialStore {
  credentials: Map<string, unknown>
  settings: Map<string, unknown>
}

interface Stored {
  kind: CredentialKind
  secret: unknown
  metadata: CredentialMetadata
  setAt: Date
  rotatedAt: Date | null
  setByUserId?: string | null
  lastCheckStatus?: CredentialStatus['lastCheckStatus']
  lastCheck?: CredentialStatus['lastCheck']
  lastCheckedAt?: Date | null
}

/** Put a credential straight into `store` (what `putCredential` does, without a database). */
export function storeCredential(
  store: CredentialStore,
  kind: CredentialKind,
  secret: unknown,
  metadata: CredentialMetadata = {}
): void {
  const previous = store.credentials.get(kind) as Stored | undefined
  const now = new Date()
  store.credentials.set(kind, {
    kind,
    secret: credentialPayloadSchemas[kind].parse(secret),
    metadata,
    setAt: now,
    rotatedAt: previous ? now : null,
  } satisfies Stored)
}

/** The module's replacement: the real one with every table access pointed at `store`. */
export function mockCredentialsModule(
  real: typeof Credentials,
  store: CredentialStore
): typeof Credentials {
  const read = (kind: string) => (store.credentials.get(kind) as Stored | undefined) ?? null
  return {
    ...real,
    putCredential: (async (_db, _cfg, kind, secret, metadata, userId) => {
      const existed = store.credentials.has(kind)
      storeCredential(store, kind, secret, metadata)
      const row = read(kind) as Stored
      row.setByUserId = userId
      return { rotated: existed, setAt: row.setAt }
    }) as typeof real.putCredential,
    getCredential: (async (_db, _cfg, kind) => read(kind)) as typeof real.getCredential,
    removeCredential: async (_db, kind) => store.credentials.delete(kind),
    credentialStatus: async () =>
      CREDENTIAL_KINDS.map(kind => {
        const row = read(kind)
        return row
          ? {
              kind,
              set: true,
              metadata: row.metadata,
              setAt: row.setAt,
              setByUserId: row.setByUserId ?? null,
              rotatedAt: row.rotatedAt,
              lastCheckStatus: row.lastCheckStatus ?? null,
              lastCheck: row.lastCheck ?? null,
              lastCheckedAt: row.lastCheckedAt ?? null,
            }
          : {
              kind,
              set: false,
              setAt: null,
              setByUserId: null,
              rotatedAt: null,
              metadata: {},
              lastCheckStatus: null,
              lastCheck: null,
              lastCheckedAt: null,
            }
      }) as CredentialStatus[],
    recordCheck: async (_db, kind, checks, metadata) => {
      const row = read(kind)
      if (!row) return null
      const status = real.overallCheckStatus(checks)
      row.lastCheckStatus = status
      row.lastCheck = checks
      row.lastCheckedAt = new Date()
      if (metadata) row.metadata = { ...row.metadata, ...metadata }
      return status
    },
    getSetting: (async (_db, key) => store.settings.get(key) ?? null) as typeof real.getSetting,
    getSettings: async () => Object.fromEntries(store.settings),
    putSetting: async (_db, key, value) => {
      if (value === null || value === undefined) store.settings.delete(key)
      else store.settings.set(key, value)
    },
    compareAndSetSetting: async (_db, key, expected, value) => {
      if (!store.settings.has(key)) return false
      // jsonb equality: a stored `undefined` member is absent, as it would be in Postgres.
      const normal = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown
      if (!isDeepStrictEqual(normal(store.settings.get(key)), normal(expected))) return false
      store.settings.set(key, value)
      return true
    },
  }
}
