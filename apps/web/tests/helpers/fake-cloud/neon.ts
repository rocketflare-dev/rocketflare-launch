/**
 * FakeNeon — the Neon API v2 surface Launch touches, plus the HTTP SQL endpoint, stateful. A new
 * project has a `main` branch with `neondb_owner` and `neondb`; roles and databases live on a
 * branch, and a branch inherits its parent's roles WITH their passwords (as Neon's does). Every
 * write answers `operations[]` that start `running` and read back `finished`. See `index.ts`.
 *
 * P3 adds what coding sessions do with branches: `init_source` on create (recorded on the branch —
 * `schema-only` still copies roles and databases, which ARE the schema here, but a test can assert
 * no data was meant to come along), `endpoints: []` for a branch with no compute,
 * `GET …/branches/{b}/endpoints`, and `DELETE …/branches/{b}` (a branch with children is refused,
 * as Neon refuses it; a deleted one is a 404). `branchNamed(projectId, name)` finds one.
 *
 * Roles are modelled as a real Neon project has them (checked on Postgres 17.11): one the API
 * creates — and `neondb_owner` — is made by `cloud_admin` and is a `neon_superuser` member; one a
 * role creates in SQL (`CREATE ROLE`, which needs CREATEROLE) is ordinary and records its
 * creator. `GRANT r TO m` succeeds only for the role that created `r` (it holds ADMIN), else
 * `permission denied to grant role "r"`, as PG16+ answers `neondb_owner` for an API role.
 * `CREATE EXTENSION` needs a `neon_superuser` member unless it already exists (`IF NOT EXISTS`).
 * The HTTP SQL endpoint takes ONE statement and understands the few Launch sends (see
 * `execute`); anything else answers an empty SELECT. `DELETE …/roles/{r}` and
 * `DELETE …/databases/{d}` exist; a role that owns a database is refused. `addTable` seeds a
 * table (a database with data), `addMigrations` drizzle's `__drizzle_migrations` rows (read back
 * through `to_regclass(…)` and `count(*)`, as the re-scaffold check asks), `sqlRole` a role as if
 * created in SQL (`noLogin`: a NOLOGIN role, as an app's kit RLS role — Neon then refuses a
 * `schema-only` child of that branch, and lists it `authentication_method: no_login`).
 * `GET …/databases` lists a branch's databases; the session dev's scrub reads its owner database's
 * data schemas (`public` when it has tables) and `DROP SCHEMA … CASCADE` empties them.
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
  /** A `neon_superuser` member — every role Neon's API creates, and `neondb_owner`. */
  superuser: boolean
  /** Who created it: `cloud_admin` for the API's, else the role that ran `CREATE ROLE`. */
  createdBy: string
  /** CREATEROLE. */
  canCreateRole: boolean
  /** NOLOGIN (`authentication_method: no_login`): no password to reset, and no schema-only child. */
  noLogin?: boolean
}

export interface FakeNeonBranch {
  id: string
  name: string
  parent_id: string | null
  /** P3: how it was filled — `schema-only` copies roles and databases (the schema) but no rows. */
  init_source: 'parent-data' | 'schema-only'
  /** ISO, set on create; a test ages a branch by rewriting it (the gate-branch sweep). */
  created_at: string
  /** '' when the branch was created with `endpoints: []` (no compute). */
  endpointId: string
  /** `ep-…​.<region>.aws.neon.tech` (the direct host; pooled adds `-pooler`); '' with no endpoint. */
  host: string
  roles: Map<string, FakeNeonRole>
  databases: Map<string, { name: string; owner_name: string }>
  /** Role memberships on this branch, as `"role->member"`. */
  members: Set<string>
  /** The memberships among {@link members} granted WITH ADMIN OPTION. */
  admins: Set<string>
  /** Per database: the tables in `public`, and the extensions created. */
  tables: Map<string, Set<string>>
  extensions: Map<string, Set<string>>
  /** Per database: rows in `drizzle.__drizzle_migrations` (absent = the table does not exist). */
  migrations: Map<string, number>
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

const API_CREATOR = 'cloud_admin'

/** A role as Neon's API makes it: `cloud_admin`'s, in `neon_superuser`. */
function apiRole(name: string, password: string): FakeNeonRole {
  return { name, password, resets: 0, superuser: true, createdBy: API_CREATOR, canCreateRole: true }
}

const bare = (name: string) => name.replace(/^"(.*)"$/, '$1')

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

  /** A project's branch by name (`dev`, `session-<short>`), or undefined. */
  branchNamed(projectId: string, name: string): FakeNeonBranch | undefined {
    return [...(this.projects.get(projectId)?.branches.values() ?? [])].find(b => b.name === name)
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
      authentication_method: role.noLogin ? 'no_login' : 'password',
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
    // A real ORGANIZATION key is refused here; Launch never calls it (setup uses NEON_REGIONS).
    if (path === '/regions' && m === 'GET') {
      return neonError(404, 'not allowed for organization API keys')
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
      const initSource = input.init_source === 'schema-only' ? 'schema-only' : 'parent-data'
      // As Neon answers it (2026): a NOLOGIN role on the parent rules out a schema-only child.
      const noLogin = [...parent.roles.values()].find(r => r.noLogin)
      if (initSource === 'schema-only' && noLogin) {
        return neonError(
          400,
          `project with a legacy web access role do not support schema-only branches; role:"${noLogin.name}"`
        )
      }
      const endpoints = (req.json as { endpoints?: unknown[] } | null)?.endpoints
      const withCompute = !Array.isArray(endpoints) || endpoints.length > 0
      const branch = this.newBranch(project, name, parent.id, { initSource, withCompute })
      for (const role of parent.roles.values()) {
        branch.roles.set(role.name, { ...role, resets: 0 })
      }
      for (const db of parent.databases.values()) branch.databases.set(db.name, { ...db })
      for (const m of parent.members) branch.members.add(m)
      for (const m of parent.admins) branch.admins.add(m)
      for (const [db, t] of parent.tables) branch.tables.set(db, new Set(t))
      for (const [db, e] of parent.extensions) branch.extensions.set(db, new Set(e))
      for (const [db, n] of parent.migrations) branch.migrations.set(db, n)
      return json(
        {
          branch: this.branchJson(branch),
          endpoints: withCompute ? [this.endpointJson(branch)] : [],
          operations: [
            this.op(project, 'create_branch'),
            ...(withCompute ? [this.op(project, 'start_compute')] : []),
          ],
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

    match = rest.match(/^\/branches\/([^/]+)(\/.*)?$/)
    if (!match) return neonError(404, 'not found')
    const branch = project.branches.get(match[1])
    if (!branch) return neonError(404, 'branch not found')
    const sub = match[2] ?? ''

    if (sub === '' && m === 'GET') return json({ branch: this.branchJson(branch) })
    if (sub === '' && m === 'DELETE') {
      if ([...project.branches.values()].some(b => b.parent_id === branch.id)) {
        return neonError(422, `branch ${branch.id} has child branches`)
      }
      if (branch.parent_id === null) return neonError(422, 'cannot delete the default branch')
      project.branches.delete(branch.id)
      return json({
        branch: this.branchJson(branch),
        operations: [this.op(project, 'delete_timeline')],
      })
    }
    if (sub === '/endpoints' && m === 'GET') {
      return json({ endpoints: branch.endpointId ? [this.endpointJson(branch)] : [] })
    }

    if (sub === '/roles' && m === 'POST') {
      const name = String(body.role?.name ?? '')
      if (branch.roles.has(name)) return neonError(409, `role ${name} already exists`)
      const role = apiRole(name, this.ids.secret('npg_'))
      branch.roles.set(name, role)
      return json(
        { role: this.roleJson(branch, role, true), operations: [this.op(project, 'apply_config')] },
        201
      )
    }
    if (sub === '/databases' && m === 'GET') {
      return json({
        databases: [...branch.databases.values()].map(d => ({ ...d, branch_id: branch.id })),
      })
    }
    if (sub === '/roles' && m === 'GET') {
      return json({ roles: [...branch.roles.values()].map(r => this.roleJson(branch, r, false)) })
    }
    match = sub.match(/^\/roles\/([^/]+)$/)
    if (match && m === 'DELETE') {
      const name = decodeURIComponent(match[1])
      const role = branch.roles.get(name)
      if (!role) return neonError(404, 'role not found')
      const owned = [...branch.databases.values()].find(d => d.owner_name === name)
      if (owned) return neonError(422, `role ${name} owns database ${owned.name}`)
      branch.roles.delete(name)
      for (const key of [...branch.members]) {
        const [r, member] = key.split('->')
        if (r === name || member === name) {
          branch.members.delete(key)
          branch.admins.delete(key)
        }
      }
      return json({
        role: this.roleJson(branch, role, false),
        operations: [this.op(project, 'apply_config')],
      })
    }
    match = sub.match(/^\/databases\/([^/]+)$/)
    if (match && m === 'DELETE') {
      const name = decodeURIComponent(match[1])
      const database = branch.databases.get(name)
      if (!database) return neonError(404, 'database not found')
      branch.databases.delete(name)
      branch.tables.delete(name)
      branch.extensions.delete(name)
      return json({
        database: { ...database, branch_id: branch.id },
        operations: [this.op(project, 'apply_config')],
      })
    }
    match = sub.match(/^\/roles\/([^/]+)\/reset_password$/)
    if (match && m === 'POST') {
      const role = branch.roles.get(decodeURIComponent(match[1]))
      if (!role) return neonError(404, 'role not found')
      if (role.noLogin) return neonError(400, `role ${role.name} cannot log in`)
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
    parentId: string | null,
    opts: { initSource?: FakeNeonBranch['init_source']; withCompute?: boolean } = {}
  ): FakeNeonBranch {
    const endpointId = opts.withCompute === false ? '' : this.ids.short('ep')
    const branch: FakeNeonBranch = {
      id: this.ids.short('br'),
      name,
      parent_id: parentId,
      init_source: opts.initSource ?? 'parent-data',
      created_at: new Date().toISOString(),
      endpointId,
      host: endpointId
        ? `${endpointId}.${project.region_id.replace(/^aws-/, '')}.aws.neon.tech`
        : '',
      roles: new Map(),
      databases: new Map(),
      members: new Set(),
      admins: new Set(),
      tables: new Map(),
      extensions: new Map(),
      migrations: new Map(),
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
    const owner = apiRole('neondb_owner', this.ids.secret('npg_'))
    main.roles.set(owner.name, owner)
    main.databases.set('neondb', { name: 'neondb', owner_name: owner.name })
    return json(
      {
        project: this.projectJson(project),
        branch: this.branchJson(main),
        roles: [this.roleJson(main, owner, true)],
        databases: [{ name: 'neondb', owner_name: owner.name, branch_id: main.id }],
        endpoints: [this.endpointJson(main)],
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
      init_source: b.init_source,
      created_at: b.created_at,
    }
  }

  private endpointJson(b: FakeNeonBranch) {
    return { id: b.endpointId, host: b.host, branch_id: b.id, type: 'read_write' }
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
        const params = body.params ?? []
        this.sql.push({
          projectId: project.id,
          branchId: branch.id,
          role: role.name,
          database,
          query,
          params,
        })
        return this.execute(project, branch, role, database, query, params)
      }
    }
    return neonError(404, `endpoint ${endpointId} not found`)
  }

  /**
   * One statement, as `caller` in `database`. Understood: `CREATE ROLE`, `DROP ROLE`, `GRANT r TO
   * m`, `CREATE EXTENSION`, `CREATE TABLE`, and the catalogue reads the neon step makes
   * (`pg_roles` with `neon_superuser` membership, `pg_auth_members`, `pg_database`, `pg_tables`).
   */
  private execute(
    project: FakeNeonProject,
    branch: FakeNeonBranch,
    caller: FakeNeonRole,
    database: string,
    raw: string,
    params: unknown[]
  ): Response {
    const statements = raw
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
    if (statements.length > 1) {
      return neonError(400, 'cannot insert multiple commands into a prepared statement')
    }
    const query = statements[0] ?? ''
    const ok = (command: string, rows: Record<string, unknown>[] = []) =>
      json({ command, rowCount: rows.length, rows, fields: [] })
    let match: RegExpExecArray | null

    match = /^CREATE\s+ROLE\s+("?\w+"?)(.*)$/is.exec(query)
    if (match) {
      const name = bare(match[1])
      if (!caller.canCreateRole) return neonError(400, 'permission denied to create role')
      if (branch.roles.has(name)) return neonError(400, `role "${name}" already exists`)
      const attrs = match[2]
      const password = /PASSWORD\s+'((?:[^']|'')*)'/i.exec(attrs)?.[1]?.replaceAll("''", "'")
      branch.roles.set(name, {
        name,
        password: password ?? '',
        resets: 0,
        superuser: false,
        createdBy: caller.name,
        canCreateRole: /\bCREATEROLE\b/i.test(attrs),
        noLogin: /\bNOLOGIN\b/i.test(attrs),
      })
      return ok('CREATE')
    }
    match = /^DROP\s+ROLE\s+(IF\s+EXISTS\s+)?("?\w+"?)$/i.exec(query)
    if (match) {
      const name = bare(match[2])
      const target = branch.roles.get(name)
      if (!target) {
        return match[1] ? ok('DROP') : neonError(400, `role "${name}" does not exist`)
      }
      if (target.createdBy !== caller.name) {
        return neonError(400, `permission denied to drop role "${name}"`)
      }
      branch.roles.delete(name)
      return ok('DROP')
    }
    match = /^GRANT\s+("?\w+"?)\s+TO\s+("?\w+"?)(\s+WITH\s+ADMIN\s+OPTION)?$/i.exec(query)
    if (match) {
      const [name, member] = [bare(match[1]), bare(match[2])]
      const target = branch.roles.get(name)
      if (!target) return neonError(400, `role "${name}" does not exist`)
      if (!branch.roles.has(member)) return neonError(400, `role "${member}" does not exist`)
      if (target.createdBy !== caller.name) {
        return neonError(400, `permission denied to grant role "${name}"`)
      }
      branch.members.add(`${name}->${member}`)
      if (match[3]) branch.admins.add(`${name}->${member}`)
      this.grants.push({ projectId: project.id, role: name, member })
      return ok('GRANT')
    }
    match = /^CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/i.exec(query)
    if (match) {
      const name = bare(match[2])
      const installed = branch.extensions.get(database) ?? new Set<string>()
      if (installed.has(name)) {
        return match[1] ? ok('CREATE') : neonError(400, `extension "${name}" already exists`)
      }
      if (!caller.superuser)
        return neonError(400, `permission denied to create extension "${name}"`)
      installed.add(name)
      branch.extensions.set(database, installed)
      return ok('CREATE')
    }
    match = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:public\.)?("?\w+"?)/i.exec(query)
    if (match) {
      this.addTable(project.id, branch.id, database, bare(match[2]))
      return ok('CREATE')
    }
    // The session dev's scrub: the schemas of `database` holding relations (here: `public`).
    if (/FROM\s+pg_class\s+c\s+JOIN\s+pg_namespace/i.test(query)) {
      return ok('SELECT', branch.tables.get(database)?.size ? [{ name: 'public' }] : [])
    }
    match = /^DROP\s+SCHEMA\s+(IF\s+EXISTS\s+)?("?\w+"?)\s+CASCADE$/i.exec(query)
    if (match) {
      if (bare(match[2]) === 'public') branch.tables.delete(database)
      return ok('DROP')
    }
    if (/FROM\s+pg_roles\s+r\s+WHERE\s+r\.rolname\s+IN/i.test(query)) {
      const rows = params
        .map(p => branch.roles.get(String(p)))
        .filter((r): r is FakeNeonRole => r !== undefined)
        .map(r => ({ name: r.name, superuser: r.superuser ? 't' : 'f' }))
      return ok('SELECT', rows)
    }
    if (/^SELECT\s+1\s+FROM\s+pg_auth_members/i.test(query)) {
      const key = `${params[0]}->${params[1]}`
      // Postgres 16+: a role's creator holds it WITH ADMIN OPTION without a GRANT.
      const admin =
        branch.admins.has(key) || branch.roles.get(String(params[0]))?.createdBy === params[1]
      const member = /admin_option/i.test(query) ? admin : branch.members.has(key)
      return ok('SELECT', member ? [{ '?column?': '1' }] : [])
    }
    if (/FROM\s+pg_database\s+WHERE\s+datname/i.test(query)) {
      return ok('SELECT', branch.databases.has(String(params[0])) ? [{ '?column?': '1' }] : [])
    }
    if (/to_regclass\('drizzle\.__drizzle_migrations'\)/i.test(query)) {
      return ok('SELECT', [{ tracked: branch.migrations.has(database) ? 't' : 'f' }])
    }
    if (/FROM\s+drizzle\.__drizzle_migrations/i.test(query)) {
      const n = branch.migrations.get(database)
      if (n === undefined) {
        return neonError(400, 'relation "drizzle.__drizzle_migrations" does not exist')
      }
      return ok('SELECT', [{ n: String(n) }])
    }
    if (/FROM\s+pg_tables\s+WHERE\s+schemaname\s*=\s*'public'/i.test(query)) {
      return ok('SELECT', [{ n: String(branch.tables.get(database)?.size ?? 0) }])
    }
    return ok('SELECT')
  }

  /** Seed a table in `public` of a branch's database — a database with data in it. */
  addTable(projectId: string, branchId: string, database: string, table: string): void {
    const branch = this.projects.get(projectId)?.branches.get(branchId)
    if (!branch?.databases.has(database)) throw new Error(`no database ${database} to seed`)
    const tables = branch.tables.get(database) ?? new Set<string>()
    tables.add(table)
    branch.tables.set(database, tables)
  }

  /**
   * Seed drizzle's migrations table in a branch's database with `count` applied migrations (0: the
   * table exists and is empty — the migrator created it, then applied nothing).
   */
  addMigrations(projectId: string, branchId: string, database: string, count: number): void {
    const branch = this.projects.get(projectId)?.branches.get(branchId)
    if (!branch?.databases.has(database)) throw new Error(`no database ${database} to seed`)
    branch.migrations.set(database, count)
  }

  /** Seed a role as if `createdBy` had run `CREATE ROLE` (not a `neon_superuser` member). */
  sqlRole(
    projectId: string,
    branchId: string,
    name: string,
    opts: { createdBy?: string; canCreateRole?: boolean; noLogin?: boolean } = {}
  ): FakeNeonRole {
    const branch = this.projects.get(projectId)?.branches.get(branchId)
    if (!branch) throw new Error(`no branch ${branchId}`)
    const role: FakeNeonRole = {
      name,
      password: this.ids.secret('npg_'),
      resets: 0,
      superuser: false,
      createdBy: opts.createdBy ?? 'neondb_owner',
      canCreateRole: opts.canCreateRole ?? false,
      noLogin: opts.noLogin ?? false,
    }
    branch.roles.set(name, role)
    return role
  }

  /** Record `GRANT role TO member` on a branch, as its creator would. */
  grant(projectId: string, branchId: string, role: string, member: string): void {
    const branch = this.projects.get(projectId)?.branches.get(branchId)
    if (!branch) throw new Error(`no branch ${branchId}`)
    branch.members.add(`${role}->${member}`)
    this.grants.push({ projectId, role, member })
  }
}
