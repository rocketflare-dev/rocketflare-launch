/**
 * The Rocketflare adapter's toml half (spec/02 `resources` + `writeConfig`): what an app's two
 * wrangler tomls DECLARE, and the patch that writes Launch's answers back into them.
 *
 * The patcher is a port of the PURE half of the kit's `apps/web/scripts/provision/patch-toml.ts`
 * (kit 0.15) — that file imports `node:fs` and runs as a CLI, so it cannot be imported into the
 * Worker. The rule it follows is the kit's: `wrangler --update-config` throws on the commented
 * TOML the kit ships, and re-serialising through a TOML library would drop every comment, so each
 * value is patched with an anchored regex and every other byte is preserved. Idempotent: writing
 * the value already there is a no-op, and a DIFFERENT real (non-placeholder) id throws unless
 * `force` — an environment's KV id is not something to overwrite by accident.
 *
 * `writeConfig(tomlText, env, values)` is the pipeline's `write_config` step for one file
 * (plan §0.4): every KV `<PLACEHOLDER>` filled, `APP_URL` / `EMAIL_FROM`, the Launch sign-in vars
 * (`TENANCY_MODE="single"`, `SIGNUP_MODE="open"`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
 * `AUTH_OIDC_ONLY="true"`), `DATABASE_DRIVER="neon"` and `workers_dev = false` (Launch owns the
 * app's routes, spec/04). It refuses to return a file that still carries a placeholder. Both
 * files get the same KEYS, so the kit's parity test stays green.
 *
 * `resources(tomlText)` reads the declarations with `smol-toml` (through `parseWranglerToml` for
 * the parts the import already understands): what the pipeline must create, register and route.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { parse as parseToml } from 'smol-toml'
import type { CloudflareQueueConsumerSettings } from '../cloudflare'
import { ManifestError, parseWranglerToml } from '../rocketflare-manifest'

// ---- the patcher (ported from the kit's patch-toml.ts) --------------------------------------------

export class TomlPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TomlPatchError'
  }
}

/** One plugin-style binding block (the kit's `BindingBlock`). */
export interface BindingBlock {
  type: 'kv' | 'queue' | 'r2' | 'workflow' | 'durable_object'
  binding: string
  /** queue → `queue`, r2 → `bucket_name`, workflow → `name`. */
  name?: string
  /** KV only: the namespace id, or a `<PLACEHOLDER>`. */
  id?: string
  /** queue only: also emit a `[[queues.consumers]]` block. */
  consumer?: boolean
  className?: string
  pluginId?: string
}

/** One `[[migrations]]` entry — append-only, never renumbered. */
export interface MigrationBlock {
  tag: string
  newClasses?: string[]
  newSqliteClasses?: string[]
  deletedClasses?: string[]
  pluginId?: string
}

export interface TomlPatch {
  /** `neon` sets `DATABASE_DRIVER = "neon"` and removes any `[[hyperdrive]]` HYPERDRIVE block. */
  databaseDriver?: 'neon'
  /** Value for `[[kv_namespaces]] id` by binding name (placeholder or the same id only). */
  kvIds?: Record<string, string>
  /** `[vars] APP_URL`. */
  appUrl?: string
  /** `[vars] EMAIL_FROM`. */
  emailFrom?: string
  /** `[vars]` keys SET — replaced when present, appended when absent. */
  setVars?: Array<{ key: string; value: string }>
  /** Comment line(s) written above the keys `setVars` appends, once. */
  setVarsComment?: string
  /** `workers_dev = <value>`: replaced, or inserted after `name = …`. */
  workersDev?: boolean
  bindings?: BindingBlock[]
  migrations?: MigrationBlock[]
  /** Cron expressions appended to `[triggers] crons` (idempotent). */
  crons?: string[]
  /** `[vars]` keys appended when absent; an existing key is left alone (the kit's rule). */
  vars?: Array<{ key: string; value: string }>
  /** Route prefixes appended to `[assets] run_worker_first` as `p` and `p/*` (idempotent). */
  workerFirstPrefixes?: string[]
  /** Overwrite a different existing id instead of throwing. */
  force?: boolean
}

const PLACEHOLDER = /^<[A-Z0-9_]+>$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The `<key> = "…"` line after a given `<idKey> = "<binding>"` line INSIDE the same block. The
 * lines between must each be non-empty, which stops the match running past a blank line into the
 * next block and rewriting a different binding's value.
 */
function patchBindingKey(
  text: string,
  binding: string,
  key: string,
  value: string,
  force: boolean,
  idKey = 'binding'
): string {
  const re = new RegExp(
    `(${escapeRe(idKey)}\\s*=\\s*"${escapeRe(binding)}"[^\\n]*\\n(?:[^\\n]+\\n)*?${key}\\s*=\\s*")([^"]*)(")`
  )
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`${key}\` line found under binding = "${binding}"`)
  const current = m[2]
  if (current === value) return text
  if (!PLACEHOLDER.test(current) && !force) {
    throw new TomlPatchError(
      `binding "${binding}" already has ${key} "${current}" (wanted "${value}")`
    )
  }
  return text.slice(0, m.index) + m[1] + value + m[3] + text.slice(m.index + m[0].length)
}

/** Replace the quoted value of a top-of-line `KEY = "…"`, keeping any trailing comment. */
function patchVar(text: string, key: string, value: string): string {
  const re = new RegExp(`^(${escapeRe(key)}\\s*=\\s*")([^"]*)(")`, 'm')
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`${key} = "…"\` line found`)
  if (m[2] === value) return text
  return text.slice(0, m.index) + m[1] + value + m[3] + text.slice(m.index + m[0].length)
}

/** A TOML basic string's body: `"` and `\` escaped, so a display name cannot break the file. */
function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The byte ranges of every block with this header (header line → first blank line or `[`). */
function blockRanges(text: string, header: string): Array<{ start: number; end: number }> {
  const lines = text.split('\n')
  const offsets: number[] = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== header) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '' && !/^\[/.test(lines[j])) j++
    out.push({ start: offsets[i], end: offsets[j] ?? text.length })
  }
  return out
}

function blockHasKeyValue(text: string, header: string, key: string, value: string): boolean {
  const re = new RegExp(`^${escapeRe(key)}\\s*=\\s*"${escapeRe(value)}"\\s*(?:#.*)?$`, 'm')
  return blockRanges(text, header).some(r => re.test(text.slice(r.start, r.end)))
}

/** Insert a whole block after the LAST block of the same kind (else at the end of the file). */
function insertBlock(text: string, header: string, body: string): string {
  const existing = blockRanges(text, header)
  const block = `${body.trimEnd()}\n`
  if (existing.length === 0) {
    const tail = text.endsWith('\n') ? text : `${text}\n`
    return `${tail}\n${block}`
  }
  const at = existing[existing.length - 1].end
  const before = text.slice(0, at)
  const after = text.slice(at)
  const separated = after === '' || after.startsWith('\n') ? after : `\n${after}`
  return `${before}\n${block}${separated}`
}

const SECTION: Record<
  BindingBlock['type'],
  { header: string; idKey: string; valueKey: string | null }
> = {
  kv: { header: '[[kv_namespaces]]', idKey: 'binding', valueKey: 'id' },
  queue: { header: '[[queues.producers]]', idKey: 'binding', valueKey: 'queue' },
  r2: { header: '[[r2_buckets]]', idKey: 'binding', valueKey: 'bucket_name' },
  workflow: { header: '[[workflows]]', idKey: 'binding', valueKey: 'name' },
  durable_object: { header: '[[durable_objects.bindings]]', idKey: 'name', valueKey: null },
}

/** Insert or update one binding block, idempotent by binding name (the kit's `upsertBindingBlock`). */
function upsertBindingBlock(text: string, block: BindingBlock, force: boolean): string {
  const section = SECTION[block.type]
  if (!section) throw new TomlPatchError(`unsupported binding type "${block.type}"`)
  if ((block.type === 'workflow' || block.type === 'durable_object') && !block.className) {
    throw new TomlPatchError(
      `binding "${block.binding}": className is required for a ${block.type}`
    )
  }
  const value = block.type === 'kv' ? block.id : block.name
  if (section.valueKey !== null && value === undefined) {
    throw new TomlPatchError(
      `binding "${block.binding}": ${block.type === 'kv' ? 'id' : 'name'} is required`
    )
  }
  let out = text
  const declared = new RegExp(
    `^${escapeRe(section.idKey)}\\s*=\\s*"${escapeRe(block.binding)}"\\s*(?:#.*)?$`,
    'm'
  )
  if (blockRanges(out, section.header).some(r => declared.test(out.slice(r.start, r.end)))) {
    if (section.valueKey !== null && value !== undefined) {
      out = patchBindingKey(out, block.binding, section.valueKey, value, force, section.idKey)
    }
  } else {
    const who = block.pluginId ? `plugin ${block.pluginId}` : 'plugin'
    const lines = [`# ${who}: declared in its plugin.json.`, section.header]
    if (block.type === 'durable_object') {
      lines.push(`name = "${block.binding}"`, `class_name = "${block.className}"`)
    } else {
      lines.push(`binding = "${block.binding}"`)
      if (section.valueKey) lines.push(`${section.valueKey} = "${value}"`)
      if (block.className) lines.push(`class_name = "${block.className}"`)
    }
    out = insertBlock(out, section.header, lines.join('\n'))
  }
  if (block.type === 'queue' && block.consumer && value !== undefined) {
    const header = '[[queues.consumers]]'
    if (!blockHasKeyValue(out, header, 'queue', value)) {
      out = insertBlock(
        out,
        header,
        `${header}\nqueue = "${value}"\nmax_batch_size = 10\nmax_batch_timeout = 5\nmax_retries = 3\nretry_delay = 60`
      )
    }
  }
  return out
}

/** The body of a `key = [ … ]` array — string- and comment-aware, so a `]` in either is not the end. */
function arrayRange(text: string, key: string): { start: number; end: number } | null {
  const m = new RegExp(`^${escapeRe(key)}\\s*=\\s*\\[`, 'm').exec(text)
  if (!m) return null
  let inString = false
  let inComment = false
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]
    if (inComment) {
      if (ch === '\n') inComment = false
    } else if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '#') inComment = true
    else if (ch === '"') inString = true
    else if (ch === ']') return { start: m.index + m[0].length, end: i }
  }
  return null
}

/**
 * The quoted values of an array body, IGNORING comments. The kit's `appendToArray` (0.15) reads
 * every quoted string, so a value merely mentioned in a comment — the kit's tomls mention the
 * analytics plugin's `"/cubejs-api"`, `"/mcp"` and `"15 * * * *"` — counted as present and was
 * never written.
 */
export function tomlArrayValues(body: string): string[] {
  const out: string[] = []
  for (const line of body.split('\n')) {
    let code = ''
    let inString = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (!inString && ch === '#') break
      if (ch === '"') inString = !inString
      code += ch
    }
    for (const v of code.matchAll(/"([^"]*)"/g)) out.push(v[1])
  }
  return out
}

/** Append values to a `key = [ … ]` array, skipping any already present (shape kept). */
function appendToArray(text: string, key: string, values: string[]): string {
  const r = arrayRange(text, key)
  if (!r) throw new TomlPatchError(`no \`${key} = [...]\` array found`)
  const inner = text.slice(r.start, r.end)
  const present = tomlArrayValues(inner)
  const missing = values.filter(v => !present.includes(v))
  if (missing.length === 0) return text
  let body: string
  if (inner.includes('\n')) {
    const indent = /\n([ \t]+)\S/.exec(inner)?.[1] ?? '  '
    const added = missing.map(v => `${indent}"${v}",`).join('\n')
    const head = inner.replace(/\n[ \t]*$/, '').replace(/[ \t]+$/, '')
    const closeIndent = /\n([ \t]*)$/.exec(inner)?.[1] ?? ''
    body = `${head}\n${added}\n${closeIndent}`
  } else {
    body = [...present, ...missing].map(v => `"${v}"`).join(', ')
  }
  return text.slice(0, r.start) + body + text.slice(r.end)
}

/** The line index of the last `KEY = …` assignment inside `[vars]`, or `[vars]` itself. */
function lastVarsLine(lines: string[]): number {
  const start = lines.findIndex(l => l.trim() === '[vars]')
  if (start === -1) throw new TomlPatchError('no `[vars]` table found')
  let last = start
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) break
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[i])) last = i
  }
  return last
}

/** Insert `lines` after the last `[vars]` assignment (above the kit's closing comments). */
function insertIntoVars(text: string, newLines: string[]): string {
  const lines = text.split('\n')
  const last = lastVarsLine(lines)
  const insertAt = lines.slice(0, last + 1).reduce((n, l) => n + l.length + 1, 0)
  return `${text.slice(0, insertAt)}${newLines.join('\n')}\n${text.slice(insertAt)}`
}

function hasVar(text: string, key: string): boolean {
  return new RegExp(`^${escapeRe(key)}\\s*=`, 'm').test(text)
}

/** Append `KEY = "value"` to `[vars]` when absent; an existing key is left as it is. */
function appendVar(text: string, key: string, value: string): string {
  if (hasVar(text, key)) return text
  return insertIntoVars(text, [`${key} = "${tomlEscape(value)}"`])
}

/** Set `[vars]` keys: replace present ones, append the rest as one block under `comment`. */
function setVars(text: string, entries: Array<{ key: string; value: string }>, comment?: string) {
  let out = text
  const missing: string[] = []
  for (const { key, value } of entries) {
    if (hasVar(out, key)) out = patchVar(out, key, tomlEscape(value))
    else missing.push(`${key} = "${tomlEscape(value)}"`)
  }
  if (missing.length === 0) return out
  const commentLines = comment ? comment.split('\n').map(l => `# ${l}`) : []
  return insertIntoVars(out, [...commentLines, ...missing])
}

function appendMigration(text: string, block: MigrationBlock): string {
  const header = '[[migrations]]'
  if (blockHasKeyValue(text, header, 'tag', block.tag)) return text
  const lines = [
    `# ${block.pluginId ? `plugin ${block.pluginId}` : 'plugin'}: Durable Object classes.`,
    '# Append-only — never renumber or rewrite a tag Cloudflare has already applied.',
    header,
    `tag = "${block.tag}"`,
  ]
  const list = (key: string, classes?: string[]) => {
    if (classes?.length) lines.push(`${key} = [${classes.map(c => `"${c}"`).join(', ')}]`)
  }
  list('new_classes', block.newClasses)
  list('new_sqlite_classes', block.newSqliteClasses)
  list('deleted_classes', block.deletedClasses)
  return insertBlock(text, header, lines.join('\n'))
}

/** `DATABASE_DRIVER = "neon"` (inserted after `TENANT_SCOPE_MODE` when absent), no Hyperdrive. */
function patchNeonDriver(text: string): string {
  let out = text
  if (hasVar(out, 'DATABASE_DRIVER')) out = patchVar(out, 'DATABASE_DRIVER', 'neon')
  else {
    const anchor = /^TENANT_SCOPE_MODE\s*=[^\n]*\n/m.exec(out)
    out = anchor
      ? `${out.slice(0, anchor.index + anchor[0].length)}DATABASE_DRIVER = "neon"\n${out.slice(anchor.index + anchor[0].length)}`
      : appendVar(out, 'DATABASE_DRIVER', 'neon')
  }
  const declared = /^binding\s*=\s*"HYPERDRIVE"\s*(?:#.*)?$/m
  const blocks = blockRanges(out, '[[hyperdrive]]').filter(r =>
    declared.test(out.slice(r.start, r.end))
  )
  for (const r of blocks.reverse()) {
    const end = out.slice(r.end, r.end + 1) === '\n' ? r.end + 1 : r.end
    out = out.slice(0, r.start) + out.slice(end)
  }
  return out
}

const WORKERS_DEV_COMMENT =
  '# Launch routes this app to its own host (spec/04), so there is no workers.dev host.'

/** `workers_dev = <value>` — the kit's staging "Fallback host" comment goes with the old value. */
function patchWorkersDev(text: string, value: boolean): string {
  const line = /^workers_dev\s*=\s*(true|false)[^\n]*$/m.exec(text)
  if (line) {
    if (line[1] === String(value)) return text
    const before = text.slice(0, line.index)
    const fallback = /# Fallback host[^\n]*\n$/.exec(before)
    const head = fallback ? `${before.slice(0, fallback.index)}${WORKERS_DEV_COMMENT}\n` : before
    return `${head}workers_dev = ${value}${text.slice(line.index + line[0].length)}`
  }
  const nameLine = /^name\s*=\s*"[^"]*"[^\n]*\n/m.exec(text)
  if (!nameLine) throw new TomlPatchError('no `name = "…"` line found')
  const at = nameLine.index + nameLine[0].length
  return `${text.slice(0, at)}\n${WORKERS_DEV_COMMENT}\nworkers_dev = ${value}\n${text.slice(at)}`
}

/** Apply `patch` to one toml's text. Pure; throws `TomlPatchError`. */
export function patchToml(text: string, patch: TomlPatch): string {
  let out = text
  const force = patch.force ?? false
  if (patch.databaseDriver === 'neon') out = patchNeonDriver(out)
  for (const [binding, id] of Object.entries(patch.kvIds ?? {})) {
    out = patchBindingKey(out, binding, 'id', id, force)
  }
  if (patch.appUrl !== undefined) out = patchVar(out, 'APP_URL', tomlEscape(patch.appUrl))
  if (patch.emailFrom !== undefined) out = patchVar(out, 'EMAIL_FROM', tomlEscape(patch.emailFrom))
  if (patch.setVars?.length) out = setVars(out, patch.setVars, patch.setVarsComment)
  if (patch.workersDev !== undefined) out = patchWorkersDev(out, patch.workersDev)
  for (const block of patch.bindings ?? []) out = upsertBindingBlock(out, block, force)
  for (const block of patch.migrations ?? []) out = appendMigration(out, block)
  if (patch.crons?.length) out = appendToArray(out, 'crons', patch.crons)
  if (patch.workerFirstPrefixes?.length) {
    out = appendToArray(
      out,
      'run_worker_first',
      patch.workerFirstPrefixes.flatMap(p => [p, `${p}/*`])
    )
  }
  for (const v of patch.vars ?? []) out = appendVar(out, v.key, v.value)
  return out
}

/** A top-level (or `[vars]`) `KEY = "…"` value, without parsing the document. */
export function readTomlString(text: string, key: string): string | undefined {
  return new RegExp(`^${escapeRe(key)}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1]
}

/** Every `<PLACEHOLDER>` string value still present in the text. */
export function tomlPlaceholders(text: string): string[] {
  return [...text.matchAll(/"(<[A-Z0-9_]+>)"/g)].map(m => m[1])
}

// ---- writeConfig -----------------------------------------------------------------------------------

/** What Launch writes into one environment's toml. No secret — secrets go on the Worker. */
export interface ConfigValues {
  /** `https://<slug>[-staging].<apps_domain>` (`appResourceNames(...).url`). */
  appUrl: string
  /** `Display Name <noreply@<notifications domain>>`. */
  emailFrom: string
  /** The KV namespace id for EVERY KV binding the toml declares, by binding name. */
  kvIds: Record<string, string>
  /** Launch as the app's OIDC issuer (spec/05). The secret is the Worker's `OIDC_CLIENT_SECRET`. */
  oidc: { issuer: string; clientId: string; label?: string }
}

/**
 * The `[vars]` Launch sets in both files (plan §0.4). One tenant, anyone the issuer lets in may
 * sign up, and sign-in goes straight to Launch: the app's own login methods are hidden.
 */
export function launchVars(values: ConfigValues): Array<{ key: string; value: string }> {
  return [
    { key: 'TENANCY_MODE', value: 'single' },
    { key: 'SIGNUP_MODE', value: 'open' },
    { key: 'OIDC_ISSUER', value: values.oidc.issuer },
    { key: 'OIDC_CLIENT_ID', value: values.oidc.clientId },
    { key: 'OIDC_LABEL', value: values.oidc.label ?? 'Sign in with Launch' },
    { key: 'AUTH_OIDC_ONLY', value: 'true' },
  ]
}

/**
 * Write Launch's answers into one environment's toml (`env` only names the file in errors). Every
 * KV placeholder must be answered and no placeholder may remain; `TomlPatchError` otherwise.
 * Idempotent: running it again over its own output with the same values changes nothing.
 */
export function writeConfig(
  tomlText: string,
  env: AppEnvironmentName,
  values: ConfigValues
): string {
  const declared = resources(tomlText)
  const missing = declared.kv.filter(kv => values.kvIds[kv.binding] === undefined)
  if (missing.length > 0) {
    throw new TomlPatchError(
      `${env}: no KV namespace id for ${missing.map(kv => kv.binding).join(', ')}`
    )
  }
  const kvIds = Object.fromEntries(declared.kv.map(kv => [kv.binding, values.kvIds[kv.binding]]))
  const out = patchToml(tomlText, {
    databaseDriver: 'neon',
    kvIds,
    appUrl: values.appUrl,
    emailFrom: values.emailFrom,
    setVars: launchVars(values),
    setVarsComment:
      'Launch (spec/05): sign-in goes through Launch, the OIDC issuer this app is registered with.\n' +
      'Written by Launch; the client secret is the OIDC_CLIENT_SECRET Worker secret.',
    workersDev: false,
  })
  const left = tomlPlaceholders(out)
  if (left.length > 0) throw new TomlPatchError(`${env}: still has ${left.join(', ')}`)
  return out
}

// ---- resources -------------------------------------------------------------------------------------

export interface DeclaredKv {
  binding: string
  /** The real id, or null while the toml carries a placeholder. */
  id: string | null
  placeholder: string | null
}

export interface DeclaredQueueConsumer {
  queue: string
  settings: CloudflareQueueConsumerSettings
  deadLetterQueue?: string
}

/** One `[[migrations]]` entry as the toml declares it. */
export interface DeclaredMigration {
  tag: string
  newClasses: string[]
  newSqliteClasses: string[]
  deletedClasses: string[]
  renamedClasses: Array<{ from: string; to: string }>
}

/** Everything one toml declares that Launch provisions, registers or routes. */
export interface TomlResources {
  workerName: string | null
  compatibilityDate: string | null
  compatibilityFlags: string[]
  kv: DeclaredKv[]
  /** Queue producers. */
  queues: Array<{ binding: string; queue: string }>
  queueConsumers: DeclaredQueueConsumer[]
  r2: Array<{ binding: string; bucketName: string }>
  durableObjects: Array<{ binding: string; className: string }>
  workflows: Array<{ binding: string; name: string; className: string }>
  migrations: DeclaredMigration[]
  /** The newest (last) migration tag, or null. */
  doMigrationTag: string | null
  crons: string[]
  vars: Record<string, string>
  /** Binding kinds Launch does not provision for a created app (`hyperdrive`, `d1_databases`…). */
  unsupported: string[]
}

type Table = Record<string, unknown>
const asTable = (v: unknown): Table | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Table) : null
const tables = (v: unknown): Table[] =>
  Array.isArray(v) ? v.map(asTable).filter((t): t is Table => t !== null) : []
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Top-level binding sections Launch cannot provision for an app it creates. */
const UNSUPPORTED_SECTIONS = [
  'hyperdrive',
  'd1_databases',
  'vectorize',
  'services',
  'analytics_engine_datasets',
  'send_email',
  'secrets_store_secrets',
  'dispatch_namespaces',
  'mtls_certificates',
  'browser',
  'tail_consumers',
] as const

/** What one toml declares. Throws `ManifestError` when it is not TOML. */
export function resources(tomlText: string): TomlResources {
  const base = parseWranglerToml(tomlText, 'wrangler.toml')
  let doc: Table
  try {
    doc = parseToml(tomlText) as Table
  } catch (err) {
    throw new ManifestError('wrangler.toml', `not valid TOML: ${String(err).split('\n')[0]}`)
  }

  const kv = tables(doc.kv_namespaces).flatMap((t): DeclaredKv[] => {
    const binding = typeof t.binding === 'string' ? t.binding : null
    const id = typeof t.id === 'string' ? t.id : null
    if (!binding) return []
    const placeholder = id && PLACEHOLDER.test(id) ? id : null
    return [{ binding, id: placeholder ? null : id, placeholder }]
  })

  const queueConsumers = tables(asTable(doc.queues)?.consumers).flatMap(
    (t): DeclaredQueueConsumer[] => {
      if (typeof t.queue !== 'string') return []
      const timeout = num(t.max_batch_timeout)
      const settings: CloudflareQueueConsumerSettings = {
        ...(num(t.max_batch_size) !== undefined ? { batch_size: num(t.max_batch_size) } : {}),
        ...(num(t.max_retries) !== undefined ? { max_retries: num(t.max_retries) } : {}),
        ...(timeout !== undefined ? { max_wait_time_ms: timeout * 1000 } : {}),
        ...(num(t.retry_delay) !== undefined ? { retry_delay: num(t.retry_delay) } : {}),
      }
      const dlq = typeof t.dead_letter_queue === 'string' ? t.dead_letter_queue : undefined
      return [{ queue: t.queue, settings, ...(dlq ? { deadLetterQueue: dlq } : {}) }]
    }
  )

  const migrations = tables(doc.migrations).flatMap((t): DeclaredMigration[] => {
    if (typeof t.tag !== 'string') return []
    return [
      {
        tag: t.tag,
        newClasses: strings(t.new_classes),
        newSqliteClasses: strings(t.new_sqlite_classes),
        deletedClasses: strings(t.deleted_classes),
        renamedClasses: tables(t.renamed_classes).flatMap(r =>
          typeof r.from === 'string' && typeof r.to === 'string' ? [{ from: r.from, to: r.to }] : []
        ),
      },
    ]
  })

  const vars = Object.fromEntries(
    Object.entries(asTable(doc.vars) ?? {}).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v] as const] : []
    )
  )

  return {
    workerName: base.workerName,
    compatibilityDate: typeof doc.compatibility_date === 'string' ? doc.compatibility_date : null,
    compatibilityFlags: strings(doc.compatibility_flags),
    kv,
    queues: base.resources.queues ?? [],
    queueConsumers,
    r2: base.resources.r2 ?? [],
    durableObjects: base.resources.durableObjects ?? [],
    workflows: base.resources.workflows ?? [],
    migrations,
    doMigrationTag: migrations.at(-1)?.tag ?? null,
    crons: strings(asTable(doc.triggers)?.crons),
    vars,
    unsupported: UNSUPPORTED_SECTIONS.filter(s => doc[s] !== undefined),
  }
}
