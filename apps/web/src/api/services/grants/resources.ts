/**
 * Shared resources (Launch P5, plan §1.1, §1.3, §4 5b) — the bundle, its owner group and its
 * policies, behind `/api/shared-resources`:
 *
 * - `listResources`: every resource of the tenant (members read — they need the names to ask),
 *   each environment's value status, never a value;
 * - `getResource`: the detail — `holders` and the var values only for owners and admins
 *   (`access.ts`), `canManage` / `canSetValues` for this viewer;
 * - `createResource` (admins), `patchResource` (owners: name, description, items; admins also the
 *   owner group and the policies — 403 `not_resource_admin`), `archiveResource` (admins; 409
 *   `resource_has_holders` while a live grant exists);
 * - `loadResource`: the row by id in the tenant, 404 otherwise — for the other slices. Real from 5a
 *   (one query), so 5c and 5d do not wait on 5b.
 *
 * Audited `shared_resource.created|updated|archived`. Every query names the tenant.
 *
 * **Slice 5b owns this file.** From 5a everything but `loadResource` throws `NotWiredError`.
 */
import type {
  CreateSharedResourceRequest,
  PatchSharedResourceRequest,
  SharedResourceDetail,
  SharedResourceListQuery,
  SharedResourceListResponse,
} from '@launch/shared/launch-grants'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type SharedResourceRow, sharedResources } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import type { AuditActor } from '../launch/audit'
import { type GrantViewer, NotWiredError } from './types'

export async function listResources(
  _db: Database,
  _cfg: AppConfig,
  _viewer: GrantViewer,
  _query: SharedResourceListQuery
): Promise<SharedResourceListResponse> {
  throw new NotWiredError('grants/resources.listResources', '5b')
}

export async function getResource(
  _db: Database,
  _cfg: AppConfig,
  _viewer: GrantViewer,
  _id: string
): Promise<SharedResourceDetail> {
  throw new NotWiredError('grants/resources.getResource', '5b')
}

export async function createResource(
  _db: Database,
  _cfg: AppConfig,
  _viewer: GrantViewer,
  _input: CreateSharedResourceRequest,
  _actor: AuditActor
): Promise<SharedResourceDetail> {
  throw new NotWiredError('grants/resources.createResource', '5b')
}

export async function patchResource(
  _db: Database,
  _cfg: AppConfig,
  _viewer: GrantViewer,
  _id: string,
  _patch: PatchSharedResourceRequest,
  _actor: AuditActor
): Promise<SharedResourceDetail> {
  throw new NotWiredError('grants/resources.patchResource', '5b')
}

export async function archiveResource(
  _db: Database,
  _viewer: GrantViewer,
  _id: string,
  _actor: AuditActor
): Promise<void> {
  throw new NotWiredError('grants/resources.archiveResource', '5b')
}

export async function loadResource(
  db: Database,
  tenantId: string,
  id: string
): Promise<SharedResourceRow> {
  const [row] = await db
    .select()
    .from(sharedResources)
    .where(and(eq(sharedResources.tenantId, tenantId), eq(sharedResources.id, id)))
  if (!row) throw new NotFoundError('Shared resource not found')
  return row
}
