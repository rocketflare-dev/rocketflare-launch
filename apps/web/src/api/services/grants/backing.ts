/**
 * The backing a push writes through (Launch P5, plan §1.11, spec/12 #11) — the `GrantBacking` seam
 * (`types.ts`):
 *
 * - `WorkerSecretsBacking`: `CloudflareClient.putWorkerSecret` per entry and
 *   `deleteWorkerSecret` per name (a 404 counts as done), every value registered for redaction
 *   first (the `putWorkerSecrets` pattern);
 * - `LocalGrantBacking` (`GRANT_BACKEND=local`, development only — `loadConfig` refuses it
 *   elsewhere): records the names and calls no vendor;
 * - `grantBackingFor(deps)`: the one the config names, with the vendors from
 *   `loadPipelineVendors` + `cloudflareClient` (`pipeline/context.ts`).
 *
 * **The first push onto a Worker that still carries the var as `plain_text`.** A plugin install
 * writes its non-secret vars into the app's tomls, so the live version of an app that has not
 * deployed since its grant was approved binds `M365_TENANT_ID` as a `plain_text` — and Cloudflare
 * refuses a secret of the same name (10053 "Binding name already in use"). The gateway drops such
 * vars on the NEXT deploy (plan §1.5); until then the push would fail. So on a 10053 whose name is a
 * `plain_text` / `json` binding of the SERVING version, the backing copies that version the way
 * `wrangler versions secret put` does — its metadata, its bindings and its code (`GET
 * …/versions/{id}`, `GET …/content/v2`) — with those vars removed and the remaining entries added as
 * `secret_text`, every other secret kept (`keep_bindings`), static assets kept (`keep_assets`), and
 * deploys it at 100%. One version, so the app never runs with neither the var nor the secret. The
 * names it replaced come back as `shadowedVars` (`putDetailed`); the push records and audits them
 * (`grant.var_shadowed`). A 10053 with no such var is rethrown: something else is wrong.
 *
 * Secrets Store is a later backing (it needs a toml binding per app, plan §5).
 *
 * **Slice 5c owns this file.**
 */
import {
  CloudflareApiError,
  CloudflareClient,
  isCloudflareNotFound,
  type WorkerMetadata,
} from '../launch/cloudflare'
import { loadPipelineVendors, requireVendor } from '../launch/pipeline/context'
import type { GrantBacking, GrantDeps, GrantPutOutcome } from './types'

/** Cloudflare's "Binding name already in use" — a secret named like a live var. */
export function isBindingNameClash(err: unknown): boolean {
  return err instanceof CloudflareApiError && /\b10053\b/.test(err.message)
}

const VAR_TYPES = new Set(['plain_text', 'json'])

export interface WorkerSecretsBackingOptions {
  client: CloudflareClient
  accountId: string
  /** Registers each value for scrubbing (a step's error text); called before any vendor call. */
  redact?: (...values: string[]) => void
}

export class WorkerSecretsBacking implements GrantBacking {
  readonly kind = 'cloudflare' as const

  constructor(private readonly opts: WorkerSecretsBackingOptions) {}

  async put(script: string, entries: Readonly<Record<string, string>>): Promise<string[]> {
    return (await this.putDetailed(script, entries)).names
  }

  async putDetailed(
    script: string,
    entries: Readonly<Record<string, string>>
  ): Promise<GrantPutOutcome> {
    const { client, accountId } = this.opts
    this.opts.redact?.(...Object.values(entries))
    const names: string[] = []
    const pending = Object.entries(entries)
    for (let i = 0; i < pending.length; i++) {
      const [name, value] = pending[i] as [string, string]
      try {
        await client.putWorkerSecret(accountId, script, name, value)
        names.push(name)
      } catch (err) {
        if (!isBindingNameClash(err)) throw err
        const rest = Object.fromEntries(pending.slice(i))
        const shadowedVars = await this.replaceVars(script, rest)
        if (shadowedVars === null) throw err
        return { names: [...names, ...Object.keys(rest)], shadowedVars }
      }
    }
    return { names, shadowedVars: [] }
  }

  /**
   * The remedy (header): a copy of the serving version without the `plain_text` / `json` bindings
   * named in `entries`, with `entries` as `secret_text`, deployed at 100%. Returns the vars it
   * dropped, or null when the serving version has none of them (the clash is something else).
   */
  private async replaceVars(
    script: string,
    entries: Readonly<Record<string, string>>
  ): Promise<string[] | null> {
    const { client, accountId } = this.opts
    const [deployment] = await client.listDeployments(accountId, script)
    const serving = deployment?.versions?.find(v => v.percentage === 100)?.version_id
    if (!serving) return null
    const version = await client.getVersion(accountId, script, serving)
    const bindings = version.resources?.bindings ?? []
    const shadowed = bindings
      .filter(b => VAR_TYPES.has(String(b.type)) && String(b.name) in entries)
      .map(b => String(b.name))
    if (shadowed.length === 0) return null

    const content = await client.getVersionContent(accountId, script, serving)
    const previous = (version.metadata ?? {}) as Partial<WorkerMetadata>
    const runtime = version.resources?.script_runtime ?? {}
    const mainModule =
      content.mainModule ??
      version.resources?.script?.main_module ??
      (typeof previous.main_module === 'string' ? previous.main_module : null)
    if (!mainModule) throw new Error(`The live version of ${script} names no main module`)
    const kept = bindings.filter(
      b =>
        // Secrets travel by keep_bindings (their text is never read back); the replaced vars go.
        b.type !== 'secret_text' && !(VAR_TYPES.has(String(b.type)) && String(b.name) in entries)
    )
    const metadata: WorkerMetadata = {
      main_module: mainModule,
      ...(runtime.compatibility_date || previous.compatibility_date
        ? { compatibility_date: runtime.compatibility_date ?? previous.compatibility_date }
        : {}),
      ...(runtime.compatibility_flags?.length || previous.compatibility_flags?.length
        ? { compatibility_flags: runtime.compatibility_flags ?? previous.compatibility_flags }
        : {}),
      bindings: [
        ...kept,
        ...Object.entries(entries).map(([name, text]) => ({ type: 'secret_text', name, text })),
      ],
      keep_bindings: ['secret_text'],
      keep_assets: true,
      annotations: {
        'workers/message': `Launch: shared config replaces the plain vars ${shadowed.join(', ')}`,
      },
    }
    const created = await client.createVersion(accountId, script, metadata, content.modules)
    await client.createDeployment(
      accountId,
      script,
      created.id,
      'Launch: shared config replaces plain vars with secrets'
    )
    return shadowed
  }

  async remove(script: string, names: readonly string[]): Promise<string[]> {
    const { client, accountId } = this.opts
    const removed: string[] = []
    for (const name of names) {
      try {
        await client.deleteWorkerSecret(accountId, script, name)
      } catch (err) {
        // Already gone is done (a retried revoke, a Worker rebuilt by hand).
        if (!isCloudflareNotFound(err)) throw err
      }
      removed.push(name)
    }
    return removed
  }
}

/**
 * Development only: records what a push WOULD have written — names, never values — and calls no
 * vendor, so the whole grant flow runs under `pnpm dev` with no Cloudflare account.
 */
export class LocalGrantBacking implements GrantBacking {
  readonly kind = 'local' as const
  /** Every write, in order: `{ op, script, names }`. */
  readonly writes: { op: 'put' | 'remove'; script: string; names: string[] }[] = []

  constructor(private readonly logger?: { info(obj: object, msg: string): void }) {}

  async put(script: string, entries: Readonly<Record<string, string>>): Promise<string[]> {
    return (await this.putDetailed(script, entries)).names
  }

  async putDetailed(
    script: string,
    entries: Readonly<Record<string, string>>
  ): Promise<GrantPutOutcome> {
    const names = Object.keys(entries)
    this.writes.push({ op: 'put', script, names })
    this.logger?.info({ script, names }, 'grants: local backing — would put these secrets')
    return { names, shadowedVars: [] }
  }

  async remove(script: string, names: readonly string[]): Promise<string[]> {
    this.writes.push({ op: 'remove', script, names: [...names] })
    this.logger?.info({ script, names }, 'grants: local backing — would remove these secrets')
    return [...names]
  }
}

/**
 * The backing `GRANT_BACKEND` names. `cloudflare` unseals the Cloudflare credential (503
 * `cloudflare_not_configured` without one) — call it inside the step that writes, never carry it.
 */
export async function grantBackingFor(
  deps: GrantDeps,
  redact?: (...values: string[]) => void
): Promise<GrantBacking> {
  if (deps.cfg.GRANT_BACKEND === 'local') return new LocalGrantBacking(deps.logger)
  const vendors = await loadPipelineVendors(deps.db, deps.cfg)
  const cf = requireVendor(vendors, 'cloudflare')
  return new WorkerSecretsBacking({
    client: new CloudflareClient(cf.apiToken, deps.fetch ? { fetch: deps.fetch } : {}),
    accountId: cf.accountId,
    ...(redact ? { redact } : {}),
  })
}
