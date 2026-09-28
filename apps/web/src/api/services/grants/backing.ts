/**
 * The backing a push writes through (Launch P5, plan §1.11, spec/12 #11) — the `GrantBacking` seam
 * (`types.ts`):
 *
 * - `WorkerSecretsBacking`: `CloudflareClient.putWorkerSecret` per entry and
 *   `deleteWorkerSecret` per name (a 404 counts as done), with the vendors from
 *   `loadPipelineVendors` + `cloudflareClient` (`pipeline/context.ts`) and every value registered
 *   for redaction first (the `putWorkerSecrets` pattern);
 * - `LocalGrantBacking` (`GRANT_BACKEND=local`, development only — `loadConfig` refuses it
 *   elsewhere): records the names and calls no vendor;
 * - `grantBackingFor(deps)`: the one the config names.
 *
 * Secrets Store is a later backing (it needs a toml binding per app, plan §5).
 *
 * **Slice 5c owns this file.** From 5a each throws `NotWiredError`.
 */
import { type GrantBacking, type GrantDeps, NotWiredError } from './types'

export class WorkerSecretsBacking implements GrantBacking {
  readonly kind = 'cloudflare' as const

  async put(_script: string, _entries: Readonly<Record<string, string>>): Promise<string[]> {
    throw new NotWiredError('WorkerSecretsBacking.put', '5c')
  }

  async remove(_script: string, _names: readonly string[]): Promise<string[]> {
    throw new NotWiredError('WorkerSecretsBacking.remove', '5c')
  }
}

export class LocalGrantBacking implements GrantBacking {
  readonly kind = 'local' as const

  async put(_script: string, _entries: Readonly<Record<string, string>>): Promise<string[]> {
    throw new NotWiredError('LocalGrantBacking.put', '5c')
  }

  async remove(_script: string, _names: readonly string[]): Promise<string[]> {
    throw new NotWiredError('LocalGrantBacking.remove', '5c')
  }
}

export async function grantBackingFor(_deps: GrantDeps): Promise<GrantBacking> {
  throw new NotWiredError('grants/backing.grantBackingFor', '5c')
}
