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
 * - Neon answers **423 Locked** while a project operation runs; a caller that writes retries it
 *   (nothing here writes yet).
 * - The default region is NOT stable across creates (S3), so Launch pins `region_id` once, in the
 *   setup wizard, and passes it on every create.
 */

export const NEON_API_BASE = 'https://console.neon.tech/api/v2'
const TIMEOUT_MS = 10_000

export interface NeonOptions {
  fetch?: typeof fetch
  apiBase?: string
}

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

export class NeonClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: NeonOptions = {}
  ) {}

  async get<T>(path: string): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch
    const res = await doFetch(`${this.opts.apiBase ?? NEON_API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as { message?: unknown }
    if (!res.ok) {
      const message = typeof body.message === 'string' ? body.message : `Neon ${res.status}`
      throw new NeonApiError(res.status, message, path)
    }
    return body as T
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
}
