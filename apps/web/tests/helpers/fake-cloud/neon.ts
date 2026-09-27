/**
 * FakeNeon — the Neon API v2 surface Launch touches, plus the HTTP SQL endpoint, stateful. A new
 * project has a `main` branch with `neondb_owner` and `neondb`; roles and databases live on a
 * branch, and a branch inherits its parent's roles WITH their passwords (as Neon's does). Every
 * write answers `operations[]` that start `running` and read back `finished`. See `index.ts`.
 */
import {
  belongsTo,
  type FakeRequest,
  type IdSource,
  json,
  type ResourceLabel,
  type VendorHandler,
} from './core'

export interface FakeNeonRole {
  name: string
  password: string
  /** How many times the password was reset on THIS branch. */
  resets: number
}

export interface FakeNeonBranch {
  id: string
  name: string
  parent_id: string | null
  endpointId: string
  /** `ep-…​.<region>.aws.neon.tech` (the direct host; pooled adds `-pooler`). */
  host: string
  roles: Map<string, FakeNeonRole>
  databases: Map<string, { name: string; owner_name: string }>
}

export interface FakeNeonProject {
  id: string
  name: string
  region_id: string
  org_id: string | null
  pg_version: number
  branches: Map<string, FakeNeonBranch>
  operations: Map<string, { id: string; action: string; status: string }>
}

/** One statement run over HTTP SQL, with who ran it. */
export interface FakeNeonSql {
  projectId: string
  branchId: string
  role: string
  database: string
  query: string
  params: unknown[]
}

const API_HOST = 'console.neon.tech'
const BASE = '/api/v2'

const neonError = (status: number, message: string) =>
  json({ code: String(status), message }, status)

export class FakeNeon implements VendorHandler {
  readonly projects = new Map<string, FakeNeonProject>()
  /** Every HTTP SQL statement, in order. */
  readonly sql: FakeNeonSql[] = []
  /** `GRANT a TO b` memberships, as `"a->b"` per project. */
  readonly grants: { projectId: string; role: string; member: string }[] = []
  /** Answer the next N API calls with 423 Locked (`FakeCloud.lockNeon`). */
  lockedCalls = 0

  constructor(
    private readonly ids: IdSource,
    readonly opts: { apiKey?: string } = {}
  ) {}

  resourcesFor(slug: string): ResourceLabel[] {
    return [...this.projects.values()]
      .filter(p => belongsTo(slug, p.name))
      .map(p => `neon:project:${p.name}`)
  }

  /** Total password resets of `role` across a project's branches. */
  resetCount(projectId: string, role: string): number {
    const project = this.projects.get(projectId)
    if (!project) return 0
    let n = 0
    for (const b of project.branches.values()) n += b.roles.get(role)?.resets ?? 0
    return n
  }

  async handle(req: FakeRequest): Promise<Response | null> {
    if (req.url.hostname === API_HOST) return this.api(req)
    if (/^api\.[^.]+.*\.neon\.tech$/.test(req.url.hostname) && req.url.pathname === '/sql') {
      return this.runSql(req)
    }
    return null
  }

  private op(project: FakeNeonProject, action: string) {
    const op = { id: this.ids.short('op'), action, status: 'running' }
    project.operations.set(op.id, op)
    return { ...op }
  }

  private roleJson(branch: FakeNeonBranch, role: FakeNeonRole, withPassword: boolean) {
    return {
      name: role.name,
      branch_id: branch.id,
      protected: false,
      ...(withPassword ? { password: role.password } : {}),
    }
  }

  private async api(req: FakeRequest): Promise<Response> {
    if (this.opts.apiKey && req.bearer !== this.opts.apiKey)
      return neonError(401, 'authorization failed')
    if (this.lockedCalls > 0) {
      this.lockedCalls--
      return neonError(
        423,
        'project already has running operations, scheduling of new ones is prohibited'
      )
    }
    if (!req.url.pathname.startsWith(BASE)) return neonError(404, 'not found')
    const path = req.url.pathname.slice(BASE.length)
    const m = req.method
    const body = (req.json ?? {}) as Record<string, Record<string, unknown>>
    let match: RegExpMatchArray | null

    if (path === '/projects' && m === 'GET') {
      return json({
        projects: [...this.projects.values()].map(p => ({
          id: p.id,
          name: p.name,
          region_id: p.region_id,
          org_id: p.org_id,
        })),
      })
    }
    if (path === '/projects' && m === 'POST') return this.createProject(body.project ?? {})
    if (path === '/regions' && m === 'GET') {
      return json({ regions: [{ region_id: 'aws-us-east-2', name: 'Ohio', default: true }] })
    }

    match = path.match(/^\/projects\/([^/]+)(\/.*)?$/)
    if (!match) return neonError(404, 'not found')
    const project = this.projects.get(match[1])
    if (!project) return neonError(404, 'project not found')
    const rest = match[2] ?? ''

    if (rest === '' && m === 'GET') return json({ project: this.projectJson(project) })
    if (rest === '' && m === 'DELETE') {
      this.projects.delete(project.id)
      return json({ project: this.projectJson(project) })
    }
    match = rest.match(/^\/operations\/([^/]+)$/)
    if (match && m === 'GET') {
      const op = project.operations.get(match[1])
      if (!op) return neonError(404, 'operation not found')
      // An operation reads back finished the first time anyone looks.
      op.status = 'finished'
      return json({ operation: { ...op } })
    }
    if (rest === '/branches' && m === 'GET') {
      return json({ branches: [...project.branches.values()].map(b => this.branchJson(b)) })
    }
    if (rest === '/branches' && m === 'POST') {
      const input = body.branch ?? {}
      const parent = input.parent_id
        ? project.branches.get(String(input.parent_id))
        : [...project.branches.values()].find(b => b.parent_id === null)
      if (!parent) return neonError(400, 'parent branch not found')
      const name = String(input.name ?? this.ids.short('br'))
      if ([...project.branches.values()].some(b => b.name === name)) {
        return neonError(409, `branch ${name} already exists`)
      }
      const branch = this.newBranch(project, name, parent.id)
      for (const role of parent.roles.values()) {
        branch.roles.set(role.name, { name: role.name, password: role.password, resets: 0 })
      }
      for (const db of parent.databases.values()) branch.databases.set(db.name, { ...db })
      return json(
        {
          branch: this.branchJson(branch),
          endpoints: [
            { id: branch.endpointId, host: branch.host, branch_id: branch.id, type: 'read_write' },
          ],
          operations: [this.op(project, 'create_branch'), this.op(project, 'start_compute')],
        },
        201
      )
    }
    if (rest === '/connection_uri' && m === 'GET') {
      const q = req.url.searchParams
      const branch = project.branches.get(q.get('branch_id') ?? '')
      if (!branch) return neonError(404, 'branch not found')
      const role = branch.roles.get(q.get('role_name') ?? '')
      const database = branch.databases.get(q.get('database_name') ?? '')
      if (!role || !database) return neonError(404, 'role or database not found')
      return json({ uri: this.uri(branch, role, database.name, q.get('pooled') === 'true') })
    }

    match = rest.match(/^\/branches\/([^/]+)(\/.*)$/)
    if (!match) return neonError(404, 'not found')
    const branch = project.branches.get(match[1])
    if (!branch) return neonError(404, 'branch not found')
    const sub = match[2]

    if (sub === '/roles' && m === 'POST') {
      const name = String(body.role?.name ?? '')
      if (branch.roles.has(name)) return neonError(409, `role ${name} already exists`)
      const role: FakeNeonRole = { name, password: this.ids.secret('npg_'), resets: 0 }
      branch.roles.set(name, role)
      return json(
        { role: this.roleJson(branch, role, true), operations: [this.op(project, 'apply_config')] },
        201
      )
    }
    if (sub === '/roles' && m === 'GET') {
      return json({ roles: [...branch.roles.values()].map(r => this.roleJson(branch, r, false)) })
    }
    match = sub.match(/^\/roles\/([^/]+)\/reset_password$/)
    if (match && m === 'POST') {
      const role = branch.roles.get(decodeURIComponent(match[1]))
      if (!role) return neonError(404, 'role not found')
      role.password = this.ids.secret('npg_')
      role.resets++
      return json({
        role: this.roleJson(branch, role, true),
        operations: [this.op(project, 'apply_config')],
      })
    }
    if (sub === '/databases' && m === 'POST') {
      const name = String(body.database?.name ?? '')
      const owner = String(body.database?.owner_name ?? '')
      if (branch.databases.has(name)) return neonError(409, `database ${name} already exists`)
      if (!branch.roles.has(owner)) return neonError(400, `role ${owner} does not exist`)
      branch.databases.set(name, { name, owner_name: owner })
      return json(
        {
          database: { name, owner_name: owner, branch_id: branch.id },
          operations: [this.op(project, 'apply_config')],
        },
        201
      )
    }
    return neonError(404, `${m} ${path} not found`)
  }

  private newBranch(
    project: FakeNeonProject,
    name: string,
    parentId: string | null
  ): FakeNeonBranch {
    const endpointId = this.ids.short('ep')
    const branch: FakeNeonBranch = {
      id: this.ids.short('br'),
      name,
      parent_id: parentId,
      endpointId,
      host: `${endpointId}.${project.region_id.replace(/^aws-/, '')}.aws.neon.tech`,
      roles: new Map(),
      databases: new Map(),
    }
    project.branches.set(branch.id, branch)
    return branch
  }

  private createProject(input: Record<string, unknown>): Response {
    const name = String(input.name ?? '')
    const project: FakeNeonProject = {
      id: this.ids.short('proj'),
      name,
      region_id: String(input.region_id ?? 'aws-us-east-2'),
      org_id: input.org_id ? String(input.org_id) : null,
      pg_version: Number(input.pg_version ?? 17),
      branches: new Map(),
      operations: new Map(),
    }
    this.projects.set(project.id, project)
    const main = this.newBranch(project, 'main', null)
    const owner: FakeNeonRole = {
      name: 'neondb_owner',
      password: this.ids.secret('npg_'),
      resets: 0,
    }
    main.roles.set(owner.name, owner)
    main.databases.set('neondb', { name: 'neondb', owner_name: owner.name })
    return json(
      {
        project: this.projectJson(project),
        branch: this.branchJson(main),
        roles: [this.roleJson(main, owner, true)],
        databases: [{ name: 'neondb', owner_name: owner.name, branch_id: main.id }],
        endpoints: [
          { id: main.endpointId, host: main.host, branch_id: main.id, type: 'read_write' },
        ],
        operations: [this.op(project, 'create_timeline'), this.op(project, 'start_compute')],
        connection_uris: [{ connection_uri: this.uri(main, owner, 'neondb', false) }],
      },
      201
    )
  }

  private projectJson(p: FakeNeonProject) {
    return {
      id: p.id,
      name: p.name,
      region_id: p.region_id,
      org_id: p.org_id,
      pg_version: p.pg_version,
    }
  }

  private branchJson(b: FakeNeonBranch) {
    return {
      id: b.id,
      name: b.name,
      parent_id: b.parent_id ?? undefined,
      default: b.parent_id === null,
    }
  }

  private uri(
    branch: FakeNeonBranch,
    role: FakeNeonRole,
    database: string,
    pooled: boolean
  ): string {
    const host = pooled ? branch.host.replace(/^([^.]+)/, '$1-pooler') : branch.host
    return `postgresql://${role.name}:${role.password}@${host}/${database}?sslmode=require`
  }

  /** `POST https://api.<region>.aws.neon.tech/sql` — authenticated by the connection string. */
  private runSql(req: FakeRequest): Response {
    const conn = req.headers.get('neon-connection-string')
    if (!conn) return neonError(400, 'Neon-Connection-String header is required')
    const uri = new URL(conn)
    const host = uri.hostname.replace(/-pooler(?=\.)/, '')
    const endpointId = host.split('.')[0]
    for (const project of this.projects.values()) {
      for (const branch of project.branches.values()) {
        if (branch.endpointId !== endpointId) continue
        const role = branch.roles.get(decodeURIComponent(uri.username))
        if (!role || role.password !== decodeURIComponent(uri.password)) {
          return neonError(400, `password authentication failed for user "${uri.username}"`)
        }
        const database = uri.pathname.slice(1)
        if (!branch.databases.has(database))
          return neonError(400, `database "${database}" does not exist`)
        const body = (req.json ?? {}) as { query?: string; params?: unknown[] }
        const query = String(body.query ?? '')
        this.sql.push({
          projectId: project.id,
          branchId: branch.id,
          role: role.name,
          database,
          query,
          params: body.params ?? [],
        })
        const grant = /^\s*GRANT\s+"?(\w+)"?\s+TO\s+"?(\w+)"?/i.exec(query)
        if (grant) this.grants.push({ projectId: project.id, role: grant[1], member: grant[2] })
        return json({ command: grant ? 'GRANT' : 'SELECT', rowCount: 0, rows: [], fields: [] })
      }
    }
    return neonError(404, `endpoint ${endpointId} not found`)
  }
}
