/**
 * The Neon API v2 client Launch acts with (spec/03) — Worker-safe, and every call takes an injected
 * `fetch`. `apps/web/scripts/provision/neon.ts` is the Node-side sibling; a reference, never an
 * import.
 *
 * API facts (api-docs.neon.tech/reference, checked 2026-09-27, and spike S3):
 *
 * - Base `https://console.neon.tech/api/v2`, `Authorization: Bearer <key>`.
 * - `GET /projects?limit=&org_id=` → `{ projects: [{ id, name, region_id, org_id }] }`. An
 *   ORGANIZATION key is scoped to its org; each project names that org, which is how the setup
 *   check discovers `org_id` when nobody entered it.
 * - `GET /regions?org_id=` → `{ regions: [{ region_id, name, default }] }` — the regions that org
 *   may create projects in.
 * - Launch holds an org key, never a personal one, and an org key **cannot mint project-scoped
 *   keys** (S3), so apps only ever get connection strings.
 * - Neon answers **423 Locked** while a project operation runs. Every call here retries it —
 *   `NEON_LOCKED_RETRIES` times, `NEON_LOCKED_DELAY_MS` apart, through an injectable `sleep` so a
 *   test is never timer-bound — and a write that returns `operations[]` can be awaited with
 *   `waitForOperations` before the next one.
 * - The default region is NOT stable across creates (S3), so Launch pins `region_id` once, in the
 *   setup wizard, and passes it on every create.
 *
 * The writes P2 adds:
 *
 * - `POST /projects {project:{name, region_id, pg_version, org_id}}` → `{ project, branch, roles,
 *   databases, endpoints, operations }` (a new project comes with `neondb_owner` and `neondb`).
 * - Roles and databases live on a BRANCH: `…/branches/{b}/roles {role:{name}}`,
 *   `…/roles/{name}/reset_password`, `…/databases {database:{name, owner_name}}`. A create or a
 *   reset answers with the PASSWORD — a secret the caller uses at once and never persists (and
 *   never returns from a Workflow step).
 * - `POST …/branches {branch:{name, parent_id?}, endpoints:[{type:'read_write'}]}`. A branch
 *   INHERITS its parent's role passwords, so the pipeline resets them on the new branch.
 * - `GET …/connection_uri?branch_id&database_name&role_name&pooled` → `{ uri }` — a secret.
 *
 * P3 (coding sessions) adds:
 *
 * - `createBranch` takes `init_source` — `schema-only` copies the parent's schema and roles but no
 *   data (the app's `dev` branch, cut from `main`: never production data) and `parent-data` (the
 *   default) everything — and the endpoints to create with it (`[]` for none).
 * - `GET …/branches/{b}/endpoints` → `{ endpoints }`, the compute (and its host) a branch has.
 * - `DELETE …/branches/{b}` → `{ branch, operations }`: a session's branch is deleted with the
 *   session (Neon caps branches per project — 10 on Launch, 25 on Scale).
 * - **HTTP SQL** (`runSql`): `POST https://api.<endpoint's region host>/sql` with the connection
 *   string in the `Neon-Connection-String` header and `{ query, params }` — what
 *   `@neondatabase/serverless`'s `neon()` does, without importing a driver into this module.
 */

export const NEON_API_BASE = 'https://console.neon.tech/api/v2'
const TIMEOUT_MS = 10_000
/** How many 423 Locked answers a call rides out, and how far apart. */
export const NEON_LOCKED_RETRIES = 30
export const NEON_LOCKED_DELAY_MS = 1000

export interface NeonOptions {
  fetch?: typeof fetch
  apiBase?: string
  /** Waits between 423 retries and operation polls; tests pass one that resolves at once. */
  sleep?: (ms: number) => Promise<void>
  lockedRetries?: number
  lockedDelayMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A failed Neon call. `message` is Neon's own `message` field, never the key. */
export class NeonApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string
  ) {
    super(message)
    this.name = 'NeonApiError'
  }
}

export interface NeonProject {
  id: string
  name: string
  region_id: string
  org_id?: string
}

export interface NeonRegion {
  region_id: string
  name: string
  default: boolean
}

/** True for a Neon 404 — what teardown counts as "already gone". */
export function isNeonNotFound(err: unknown): boolean {
  return err instanceof NeonApiError && err.status === 404
}

export interface NeonOperation {
  id: string
  action?: string
  status:
    | 'scheduling'
    | 'running'
    | 'finished'
    | 'failed'
    | 'error'
    | 'cancelling'
    | 'cancelled'
    | 'skipped'
    | string
  error?: string
}

export interface NeonBranch {
  id: string
  name: string
  parent_id?: string
  default?: boolean
  /** Echoed back on create; `schema-only` branches have no data. */
  init_source?: NeonBranchInitSource
}

/** How a new branch is filled from its parent. */
export type NeonBranchInitSource = 'parent-data' | 'schema-only'

export interface NeonRole {
  name: string
  branch_id?: string
  /** Present only on a create or a reset — a secret. */
  password?: string
}

export interface NeonDatabase {
  id?: number
  name: string
  owner_name: string
  branch_id?: string
}

export interface NeonEndpoint {
  id: string
  host: string
  branch_id: string
  type?: string
}

export interface NeonCreatedProject {
  project: NeonProject
  branch: NeonBranch
  roles: NeonRole[]
  databases: NeonDatabase[]
  endpoints: NeonEndpoint[]
  operations: NeonOperation[]
}

const enc = encodeURIComponent

/** The operation statuses that end a wait; `failed`/`error` end it by throwing. */
const DONE_OPERATION = new Set(['finished', 'skipped', 'cancelled'])
const FAILED_OPERATION = new Set(['failed', 'error'])

export class NeonClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: NeonOptions = {}
  ) {}

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? defaultSleep)(ms)
  }

  /** One call, riding out 423 Locked (a project operation is still running). */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch
    const retries = this.opts.lockedRetries ?? NEON_LOCKED_RETRIES
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await doFetch(`${this.opts.apiBase ?? NEON_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 423 && attempt < retries) {
        await res.body?.cancel().catch(() => {})
        await this.sleep(this.opts.lockedDelayMs ?? NEON_LOCKED_DELAY_MS)
        continue
      }
      const parsed = (await res.json().catch(() => ({}))) as { message?: unknown }
      if (!res.ok) {
        const message = typeof parsed.message === 'string' ? parsed.message : `Neon ${res.status}`
        throw new NeonApiError(res.status, message, path)
      }
      return parsed as T
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async listProjects(
    query: { limit?: number; orgId?: string | null } = {}
  ): Promise<NeonProject[]> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 1) })
    if (query.orgId) params.set('org_id', query.orgId)
    const body = await this.get<{ projects?: NeonProject[] }>(`/projects?${params}`)
    return body.projects ?? []
  }

  async listRegions(orgId?: string | null): Promise<NeonRegion[]> {
    const query = orgId ? `?org_id=${encodeURIComponent(orgId)}` : ''
    const body = await this.get<{ regions?: NeonRegion[] }>(`/regions${query}`)
    return body.regions ?? []
  }

  // ---- P2 writes -------------------------------------------------------------------------------

  /**
   * Poll each operation until it is done. A `failed`/`error` one throws; so does running out of
   * `maxPolls` (the step's retry takes it from there).
   */
  async waitForOperations(
    projectId: string,
    operations: readonly Pick<NeonOperation, 'id' | 'status'>[],
    maxPolls = 120
  ): Promise<void> {
    for (const op of operations) {
      let status = op.status
      for (let poll = 0; !DONE_OPERATION.has(status); poll++) {
        if (FAILED_OPERATION.has(status)) {
          throw new NeonApiError(500, `Neon operation ${op.id} ${status}`, `/projects/${projectId}`)
        }
        if (poll >= maxPolls) {
          throw new NeonApiError(
            504,
            `Neon operation ${op.id} still ${status}`,
            `/projects/${projectId}`
          )
        }
        await this.sleep(this.opts.lockedDelayMs ?? NEON_LOCKED_DELAY_MS)
        const body = await this.get<{ operation: NeonOperation }>(
          `/projects/${enc(projectId)}/operations/${enc(op.id)}`
        )
        status = body.operation.status
        if (FAILED_OPERATION.has(status)) {
          throw new NeonApiError(
            500,
            `Neon operation ${op.id} ${status}${body.operation.error ? `: ${body.operation.error}` : ''}`,
            `/projects/${projectId}`
          )
        }
      }
    }
  }

  createProject(input: {
    name: string
    regionId: string
    orgId?: string | null
    pgVersion?: number
  }): Promise<NeonCreatedProject> {
    return this.request('POST', '/projects', {
      project: {
        name: input.name,
        region_id: input.regionId,
        pg_version: input.pgVersion ?? 17,
        ...(input.orgId ? { org_id: input.orgId } : {}),
      },
    })
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request('DELETE', `/projects/${enc(projectId)}`)
  }

  /** Create a role on a branch. The answer carries its PASSWORD — use it, never store it. */
  createRole(
    projectId: string,
    branchId: string,
    name: string
  ): Promise<{ role: NeonRole; operations: NeonOperation[] }> {
    return this.request('POST', `/projects/${enc(projectId)}/branches/${enc(branchId)}/roles`, {
      role: { name },
    })
  }

  /** A new password for `roleName` on the branch — the old one stops working. A secret. */
  resetRolePassword(
    projectId: string,
    branchId: string,
    roleName: string
  ): Promise<{ role: NeonRole; operations: NeonOperation[] }> {
    return this.request(
      'POST',
      `/projects/${enc(projectId)}/branches/${enc(branchId)}/roles/${enc(roleName)}/reset_password`
    )
  }

  createDatabase(
    projectId: string,
    branchId: string,
    input: { name: string; ownerName: string }
  ): Promise<{ database: NeonDatabase; operations: NeonOperation[] }> {
    return this.request('POST', `/projects/${enc(projectId)}/branches/${enc(branchId)}/databases`, {
      database: { name: input.name, owner_name: input.ownerName },
    })
  }

  /**
   * A branch, by default with its own read-write endpoint. It inherits the parent's roles AND
   * passwords, and — unless `initSource: 'schema-only'` — its data.
   */
  createBranch(
    projectId: string,
    input: {
      name: string
      parentId?: string
      /** `parent-data` (Neon's default) or `schema-only` (no rows copied — P3's `dev` branch). */
      initSource?: NeonBranchInitSource
      /** The computes to create with it; default one `read_write`, `[]` for none. */
      endpoints?: readonly { type: 'read_write' | 'read_only' }[]
    }
  ): Promise<{ branch: NeonBranch; endpoints: NeonEndpoint[]; operations: NeonOperation[] }> {
    return this.request('POST', `/projects/${enc(projectId)}/branches`, {
      branch: {
        name: input.name,
        ...(input.parentId ? { parent_id: input.parentId } : {}),
        ...(input.initSource ? { init_source: input.initSource } : {}),
      },
      endpoints: input.endpoints ?? [{ type: 'read_write' }],
    })
  }

  /** The endpoints (computes) of one branch — where its `host` comes from. */
  async listBranchEndpoints(projectId: string, branchId: string): Promise<NeonEndpoint[]> {
    const body = await this.get<{ endpoints?: NeonEndpoint[] }>(
      `/projects/${enc(projectId)}/branches/${enc(branchId)}/endpoints`
    )
    return body.endpoints ?? []
  }

  /**
   * Delete a branch (and its endpoints). A branch that is already gone is a 404 — test it with
   * `isNeonNotFound` where "gone" is the goal. Neon refuses to delete a branch that has children.
   */
  deleteBranch(
    projectId: string,
    branchId: string
  ): Promise<{ branch: NeonBranch; operations: NeonOperation[] }> {
    return this.request('DELETE', `/projects/${enc(projectId)}/branches/${enc(branchId)}`)
  }

  /** A connection string (`pooled` = the `-pooler` host the Worker uses). A secret. */
  async connectionUri(
    projectId: string,
    input: { branchId: string; databaseName: string; roleName: string; pooled: boolean }
  ): Promise<string> {
    const query = new URLSearchParams({
      branch_id: input.branchId,
      database_name: input.databaseName,
      role_name: input.roleName,
      pooled: String(input.pooled),
    })
    const body = await this.get<{ uri: string }>(
      `/projects/${enc(projectId)}/connection_uri?${query}`
    )
    return body.uri
  }
}

export interface NeonSqlResult {
  rows: Record<string, unknown>[]
  rowCount: number | null
  command?: string
}

/**
 * The HTTP SQL endpoint for a connection string: the host's first label becomes `api.`
 * (`ep-x-123.us-east-2.aws.neon.tech` → `https://api.us-east-2.aws.neon.tech/sql`), exactly as
 * `@neondatabase/serverless` derives it.
 */
export function neonSqlEndpoint(uri: string): string {
  const host = new URL(uri).hostname
  return `https://${host.replace(/^[^.]+\./, 'api.')}/sql`
}

/**
 * Run ONE statement over Neon's HTTP SQL endpoint as the URI's role — no driver, no socket. The
 * URI is a credential: it goes in a header, and neither it nor Neon's error echoing it is logged
 * here (the caller scrubs). Used once per app, to `GRANT migrator TO app` as `neondb_owner`.
 */
export async function runSql(
  uri: string,
  query: string,
  params: readonly unknown[] = [],
  doFetch: typeof fetch = fetch
): Promise<NeonSqlResult> {
  const endpoint = neonSqlEndpoint(uri)
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Neon-Connection-String': uri,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // Every member `unknown` and narrowed here: this is Neon's wire JSON, not a driver result, and
  // `tests/config/driver-results.test.ts` rightly refuses a concretely-typed `rows` cast in src/.
  const body = (await res.json().catch(() => ({}))) as {
    message?: unknown
    rows?: unknown
    rowCount?: unknown
    command?: unknown
  }
  if (!res.ok) {
    const message = typeof body.message === 'string' ? body.message : `Neon SQL ${res.status}`
    throw new NeonApiError(res.status, message, '/sql')
  }
  return {
    rows: Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [],
    rowCount: typeof body.rowCount === 'number' ? body.rowCount : null,
    command: typeof body.command === 'string' ? body.command : undefined,
  }
}
